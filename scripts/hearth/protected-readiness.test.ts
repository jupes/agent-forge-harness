import { expect, test } from "bun:test";
import { waitForProtectedReadiness } from "./protected-readiness";

const identity = (pid: number, token: string) => ({
  pid,
  url: "http://127.0.0.1:43210",
  token,
});

test("a 403 re-reads the lock token before the protected read becomes ready", async () => {
  let current = identity(42, "stale"),
    now = 0;
  const probes: string[] = [];
  const ready = await waitForProtectedReadiness({
    expectedPid: 42,
    readIdentity: () => current,
    probe: async (seen) => {
      probes.push(seen.token);
      if (seen.token === "stale") {
        current = identity(42, "fresh");
        return { kind: "refused", status: 403 };
      }
      return {
        kind: "ready",
        status: 404,
        value: "authenticated missing-original witness",
      };
    },
    now: () => now,
    sleep: async (milliseconds) => {
      now += milliseconds;
    },
    timeoutMs: 100,
    intervalMs: 10,
  });
  expect(probes).toEqual(["stale", "fresh"]);
  expect(ready.identity.token).toBe("fresh");
  expect(ready.value).toContain("authenticated");
});

test("a changed published PID is refused without probing the replacement process", async () => {
  let current = identity(42, "current");
  const probes: string[] = [];
  await expect(
    waitForProtectedReadiness({
      expectedPid: 42,
      readIdentity: () => current,
      probe: async (seen) => {
        probes.push(seen.token);
        current = identity(43, "new-owner");
        return { kind: "refused", status: 403 };
      },
      now: () => 0,
      sleep: async () => {},
      timeoutMs: 100,
    }),
  ).rejects.toThrow("process changed");
  expect(probes).toEqual(["current"]);
});

test("a stale lock from the previous process is ignored until the expected PID publishes", async () => {
  let current = identity(41, "old-owner"),
    now = 0;
  const probes: string[] = [];
  const ready = await waitForProtectedReadiness({
    expectedPid: 42,
    readIdentity: () => current,
    probe: async (seen) => {
      probes.push(seen.token);
      return { kind: "ready", status: 404, value: "ready" };
    },
    now: () => now,
    sleep: async () => {
      current = identity(42, "new-owner");
      now += 10;
    },
    timeoutMs: 100,
    intervalMs: 10,
  });
  expect(probes).toEqual(["new-owner"]);
  expect(ready.identity.pid).toBe(42);
});

test("an unpublished generation stays bounded by the original deadline", async () => {
  let now = 0;
  const probes: string[] = [];
  await expect(
    waitForProtectedReadiness({
      expectedPid: 42,
      readIdentity: () => null,
      probe: async (seen) => {
        probes.push(seen.token);
        return { kind: "ready", status: 200, value: "ready" };
      },
      now: () => now,
      sleep: async (milliseconds) => {
        now += milliseconds;
      },
      timeoutMs: 100,
      intervalMs: 30,
    }),
  ).rejects.toThrow("100 ms deadline");
  expect(now).toBe(100);
  expect(probes).toEqual([]);
});

test("non-auth refusals surface bounded public status without leaking controls", async () => {
  let message = "";
  try {
    await waitForProtectedReadiness({
      expectedPid: 42,
      readIdentity: () => identity(42, "secret-token"),
      probe: async () => ({
        kind: "refused",
        status: 503,
        publicError: `offline\n${"x".repeat(500)} secret-token`,
      }),
      now: () => 0,
      sleep: async () => {},
      timeoutMs: 100,
    });
  } catch (error) {
    message = String(error);
  }
  expect(message).toContain("HTTP 503: offline");
  expect(message).not.toContain("secret-token");
  expect(message.length).toBeLessThan(300);
});
