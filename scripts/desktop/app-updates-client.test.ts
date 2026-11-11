import { expect, test } from "bun:test";
import { AppUpdatesView } from "../../apps/desktop/src/AppUpdatesSettings";
import { createAppUpdatesClient } from "../../apps/desktop/src/app-updates-client";
import { version } from "../../package.json";
import { attrs, findAll, textOf } from "../dashboard/ds/vnode";

const result = {
  state: "newer",
  currentVersion: version,
  checkedAt: "2026-11-10T00:00:00Z",
  release: {
    tag: "v1.0.0",
    url: "https://github.com/jupes/agent-forge-harness/releases/tag/v1.0.0",
    publishedAt: "2026-11-01T00:00:00Z",
  },
};
test("checking is explicit and single-flight; unavailable/malformed/lost replies retain stale verified facts without auto retry or installation", async () => {
  let calls = 0,
    finish = (_value: Response) => {},
    connected = true;
  const client = createAppUpdatesClient({
    canCheck: () => connected,
    changed() {},
    post: async () => {
      calls++;
      return new Promise<Response>((done) => {
        finish = done;
      });
    },
  });
  expect(calls).toBe(0);
  const first = client.check();
  void client.check();
  expect(calls).toBe(1);
  expect(client.state.busy).toBe(true);
  finish(Response.json({ ok: true, data: result, error: null }));
  await first;
  expect(client.state.fresh).toBe(true);
  const old = client.state.last;
  const unavailable = client.check();
  finish(
    Response.json({
      ok: true,
      data: {
        state: "unavailable",
        reason: "not-found",
        checkedAt: "2026-11-10T01:00:00Z",
        currentVersion: version,
      },
      error: null,
    }),
  );
  await unavailable;
  expect(client.state.last).toEqual(old);
  expect(client.state.fresh).toBe(false);
  expect(client.state.error).toContain("availability is unknown");
  const malformed = client.check();
  finish(
    Response.json({
      ok: true,
      data: { ...result, state: "equal" },
      error: null,
    }),
  );
  await malformed;
  expect(client.state.last).toEqual(old);
  expect(client.state.fresh).toBe(false);
  expect(calls).toBe(3);
  connected = false;
  await client.check();
  expect(calls).toBe(3);
  const view = AppUpdatesView({ state: client.state, check() {}, connected });
  expect(attrs(findAll(view, "button")[0])["disabled"]).toBe(true);
  expect(textOf(view)).toContain("may be out of date");
  expect(textOf(view)).toContain("Automatic installation is unavailable");
  expect(findAll(view, "a")).toHaveLength(0);
  expect(attrs(findAll(view, "input")[0])["readOnly"]).toBe(true);
  client.dispose();
});
test("lost replies and disposed consumers never leak raw errors or run another request", async () => {
  let calls = 0,
    changes = 0,
    fail = (_reason: Error) => {};
  const client = createAppUpdatesClient({
    canCheck: () => true,
    changed() {
      changes++;
    },
    post: async () => {
      calls++;
      return new Promise<Response>((_done, reject) => {
        fail = reject;
      });
    },
  });
  const request = client.check();
  fail(Error("PRIVATE_RAW_ERROR"));
  await request;
  expect(client.state.error).not.toContain("PRIVATE");
  expect(client.state.fresh).toBe(false);
  expect(calls).toBe(1);
  const pending = client.check();
  client.dispose();
  const before = changes;
  fail(Error("PRIVATE_LATE_ERROR"));
  await pending;
  expect(changes).toBe(before);
  await client.check();
  expect(calls).toBe(2);
});
