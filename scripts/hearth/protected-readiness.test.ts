import { expect, test } from "bun:test";
import {
  readProtectedResponseBody,
  sanitizeProtectedReadinessError,
  waitForProtectedReadiness,
} from "./protected-readiness";

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
        publicError: `secret-token offline\n${"x".repeat(500)}`,
      }),
      now: () => 0,
      sleep: async () => {},
      timeoutMs: 100,
    });
  } catch (error) {
    message = String(error);
  }
  expect(message).toContain("HTTP 503: [redacted] offline");
  expect(message).not.toContain("secret-token");
  expect(message.length).toBeLessThan(300);
});

test("a pending readiness probe is aborted at the original deadline", async () => {
  let aborted = false;
  const started = Date.now();
  await expect(
    waitForProtectedReadiness({
      expectedPid: 42,
      readIdentity: () => identity(42, "token"),
      probe: (_seen, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              aborted = true;
              reject(new Error("aborted"));
            },
            { once: true },
          );
        }),
      now: () => started,
      sleep: async () => {},
      timeoutMs: 10,
    }),
  ).rejects.toThrow("timed out");
  expect(aborted).toBe(true);
  expect(Date.now() - started).toBeLessThan(500);
});

test("a pending next-generation probe preserves the preceding 403 diagnosis", async () => {
  let probes = 0;
  await expect(
    waitForProtectedReadiness({
      expectedPid: 42,
      readIdentity: () => identity(42, "token"),
      probe: (_seen, signal) => {
        probes += 1;
        if (probes === 1)
          return Promise.resolve({
            kind: "refused" as const,
            status: 403,
            publicError: "credential not installed",
          });
        return new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        });
      },
      now: () => 0,
      sleep: async () => {},
      timeoutMs: 10,
    }),
  ).rejects.toThrow("last HTTP 403: credential not installed");
  expect(probes).toBe(2);
});

test("a ready response body remains under the deadline after its headers arrive", async () => {
  let cancelled = false;
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("{"));
      },
      cancel() {
        cancelled = true;
      },
    }),
    { status: 200 },
  );
  await expect(
    waitForProtectedReadiness({
      expectedPid: 42,
      readIdentity: () => identity(42, "token"),
      probe: async (_seen, signal) => {
        const body = await readProtectedResponseBody(response, signal, 65_536);
        const bufferedBody = new ArrayBuffer(body.byteLength);
        new Uint8Array(bufferedBody).set(body);
        return {
          kind: "ready",
          status: 200,
          value: new Response(bufferedBody, { status: 200 }),
        };
      },
      now: () => 0,
      sleep: async () => {},
      timeoutMs: 10,
    }),
  ).rejects.toThrow("timed out");
  expect(cancelled).toBe(true);
});

test("body cancellation cannot turn a valid prefix into a complete response", async () => {
  const controller = new AbortController();
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(stream) {
        stream.enqueue(new TextEncoder().encode("{}"));
      },
    }),
    { status: 200 },
  );
  const timeout = setTimeout(() => controller.abort(), 5);
  try {
    await expect(
      readProtectedResponseBody(response, controller.signal, 65_536),
    ).rejects.toThrow("aborted");
  } finally {
    clearTimeout(timeout);
  }
});

test("public readiness errors redact early secrets before applying the text bound", () => {
  const message = sanitizeProtectedReadinessError(
    `secret-token\u0001 denied ${"x".repeat(400)}`,
    "secret-token",
  );
  expect(message).toStartWith("[redacted] denied");
  expect(message).not.toContain("secret-token");
  expect(message?.length).toBe(240);
});
