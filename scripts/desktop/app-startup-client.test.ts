import { expect, test } from "bun:test";
import { AppStartupView } from "../../apps/desktop/src/AppStartupSettings";
import { createAppStartupClient } from "../../apps/desktop/src/app-startup-client";
import { attrs, findAll, textOf } from "../dashboard/ds/vnode";
import type { StartupRequest, StartupStatus } from "./app-startup-protocol";

const id = "af000000-0000-4000-8000-000000000001";
type Available = Extract<StartupStatus, { capability: "available" }>;
const ready: Available = {
  capability: "available",
  installationKey: "a".repeat(64),
  registration: "disabled",
  fingerprint: "absent",
  record: { version: 1, revision: 0, last: null },
  checkedAt: "2026-11-10T12:00:00Z",
  canSave: true,
};
const answer = (data: StartupStatus) =>
  Response.json({ ok: true, data, error: null });
function storage() {
  let text: string | null = null;
  return {
    getItem: () => text,
    setItem(_key: string, value: string) {
      text = value;
    },
    removeItem() {
      text = null;
    },
  };
}
const complete = (request: StartupRequest): Available => ({
  ...ready,
  capability: "available",
  registration: request.enabled ? "enabled" : "disabled",
  fingerprint: request.enabled ? request.installationKey : "absent",
  record: {
    version: 1,
    revision: 1,
    last: { request, state: "completed", startedAt: ready.checkedAt },
  },
});
test("startup checkbox only drafts, cancel writes nothing, and Save persists one exact intent then refreshes confirmed state", async () => {
  const saved = storage();
  let posts = 0,
    current = ready;
  const client = createAppStartupClient({
    storage: saved,
    canAct: () => true,
    requestId: () => id,
    changed() {},
    read: async () => answer(current),
    post: async (request) => {
      posts++;
      expect(saved.getItem()).toBe(JSON.stringify(request));
      current = complete(request);
      return answer(current);
    },
  });
  expect(posts).toBe(0);
  await client.check();
  client.edit(true);
  client.discard();
  await client.save();
  expect(posts).toBe(0);
  client.edit(true);
  await client.save();
  expect(posts).toBe(1);
  expect(client.state).toMatchObject({
    pending: null,
    draft: null,
    fresh: true,
    data: { registration: "enabled" },
  });
  expect(saved.getItem()).toBeNull();
});
test("lost startup saves survive reload and only exact terminal receipt resolves them, never current registered state or another request", async () => {
  const saved = storage();
  let request: StartupRequest | null = null,
    current = ready,
    posts = 0;
  const deps = {
    storage: saved,
    canAct: () => true,
    requestId: () => id,
    changed() {},
    read: async () => answer(current),
    post: async (sent: StartupRequest) => {
      posts++;
      request = sent;
      throw Error("PRIVATE_NETWORK");
    },
  };
  const old = createAppStartupClient(deps);
  await old.check();
  old.edit(true);
  await old.save();
  old.dispose();
  const fresh = createAppStartupClient(deps);
  await fresh.check();
  expect(fresh.canSave()).toBe(false);
  expect(fresh.state.pending).not.toBeNull();
  if (!request) throw Error("Expected preserved request");
  current = complete(request);
  await fresh.check();
  expect(fresh.state.pending).toBeNull();
  expect(fresh.state.draft).toBeNull();
  expect(posts).toBe(1);
});
test("a regressed or contradictory journal response cannot replace verified startup facts", async () => {
  const request: StartupRequest = {
    requestId: id,
    installationKey: ready.installationKey,
    expectedRevision: 0,
    expectedFingerprint: "absent",
    enabled: true,
  };
  let current: StartupStatus = complete(request);
  const client = createAppStartupClient({
    storage: storage(),
    canAct: () => true,
    requestId: () => id,
    changed() {},
    read: async () => answer(current),
    post: async () => answer(current),
  });
  await client.check();
  const previous = client.state.data;
  current = ready;
  await client.check();
  expect(client.state.fresh).toBe(false);
  expect(client.state.data).toEqual(previous);
});
test("a stale refresh after a confirmed POST holds saves and retains the confirmed receipt", async () => {
  const client = createAppStartupClient({
    storage: storage(),
    canAct: () => true,
    requestId: () => id,
    changed() {},
    read: async () => answer(ready),
    post: async (request) => answer(complete(request)),
  });
  await client.check();
  client.edit(true);
  await client.save();
  expect(client.state).toMatchObject({
    fresh: false,
    pending: null,
    data: { registration: "enabled", record: { revision: 1 } },
  });
  expect(client.state.error).toContain("save was confirmed");
  expect(client.canSave()).toBe(false);
});
test("registered state, wrong receipts and unsupported status never resolve a lost request", async () => {
  for (const mode of [
    "current-state",
    "other-id",
    "other-installation",
    "superseded",
    "unsupported",
  ] as const) {
    const saved = storage();
    const sent: StartupRequest[] = [];
    let current: StartupStatus = ready,
      posts = 0;
    const deps = {
      storage: saved,
      canAct: () => true,
      requestId: () => id,
      changed() {},
      read: async () => answer(current),
      post: async (request: StartupRequest) => {
        sent.push(request);
        posts++;
        throw Error("PRIVATE_NETWORK");
      },
    };
    const old = createAppStartupClient(deps);
    await old.check();
    old.edit(true);
    await old.save();
    old.dispose();
    const captured = sent[0];
    if (!captured) throw Error("Missing saved intent");
    const result = complete(captured);
    current =
      mode === "current-state"
        ? {
            ...ready,
            registration: "enabled",
            fingerprint: ready.installationKey,
          }
        : mode === "other-id"
          ? complete({
              ...captured,
              requestId: "af000000-0000-4000-8000-000000000002",
            })
          : mode === "other-installation"
            ? {
                ...result,
                installationKey: "b".repeat(64),
                fingerprint: "b".repeat(64),
              }
            : mode === "superseded"
              ? {
                  ...result,
                  record: {
                    ...result.record,
                    revision: 2,
                    last: result.record.last
                      ? {
                          ...result.record.last,
                          request: {
                            ...result.record.last.request,
                            expectedRevision: 1,
                          },
                        }
                      : null,
                  },
                }
              : { capability: "unsupported" };
    const fresh = createAppStartupClient(deps);
    await fresh.check();
    fresh.edit(false);
    await fresh.save();
    expect(fresh.state.pending).not.toBeNull();
    expect(fresh.canSave()).toBe(false);
    expect(saved.getItem()).not.toBeNull();
    expect(posts).toBe(1);
  }
});
test("known pre-effect refusal keeps draft and requires a fresh read; unavailable storage prevents any POST", async () => {
  let posts = 0;
  const client = createAppStartupClient({
    storage: storage(),
    canAct: () => true,
    requestId: () => id,
    changed() {},
    read: async () => answer(ready),
    post: async () => {
      posts++;
      return Response.json(
        { ok: false, data: null, error: "Not echoed" },
        { status: 409 },
      );
    },
  });
  await client.check();
  client.edit(true);
  await client.save();
  expect(client.state).toMatchObject({
    pending: null,
    draft: true,
    fresh: false,
  });
  expect(client.canSave()).toBe(false);
  const blocked = createAppStartupClient({
    storage: null,
    canAct: () => true,
    requestId: () => id,
    changed() {},
    read: async () => answer(ready),
    post: async () => {
      posts++;
      return answer(ready);
    },
  });
  await blocked.check();
  blocked.edit(true);
  await blocked.save();
  expect(posts).toBe(1);
  expect(blocked.canEdit()).toBe(false);
});
test("unsupported startup is labelled explicitly and never rendered as a disabled registration", async () => {
  const client = createAppStartupClient({
    storage: storage(),
    canAct: () => true,
    requestId: () => id,
    changed() {},
    read: async () => new Response(null, { status: 404 }),
    post: async () => {
      throw Error("MUST_NOT_POST");
    },
  });
  await client.check();
  const view = AppStartupView({
    state: client.state,
    connected: true,
    editable: client.canEdit(),
    saveable: client.canSave(),
    check() {},
    edit() {},
    save() {},
    discard() {},
  });
  expect(textOf(view)).toContain("unavailable from this window");
  expect(findAll(view, "input")).toHaveLength(0);
  expect(client.canSave()).toBe(false);
  expect(attrs(findAll(view, "button")[0])["disabled"]).toBe(false);
});
