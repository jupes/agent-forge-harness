import { expect, test } from "bun:test";
import { LedgerCompactionView } from "../../apps/desktop/src/LedgerCompactionSettings";
import { createLedgerCompactionClient } from "../../apps/desktop/src/ledger-compaction-client";
import { attrs, findAll, textOf } from "../dashboard/ds/vnode";
import type {
  LedgerCompactionRequest,
  LedgerCompactionStatus,
} from "./ledger-compaction-protocol";

const id = "ac000000-0000-4000-8000-000000000001";
const ready: LedgerCompactionStatus = {
  checkedAt: "2026-11-10T12:00:00Z",
  canCompact: true,
  record: { version: 1, revision: 0, ledgerKey: "a".repeat(64), last: null },
};
const completed: LedgerCompactionStatus = {
  ...ready,
  record: {
    ...ready.record,
    revision: 1,
    last: {
      state: "completed",
      requestId: id,
      startedAt: ready.checkedAt,
      cutoffAt: "2026-08-12T12:00:00Z",
      events: 3,
      days: 1,
    },
  },
};
const answer = (data: LedgerCompactionStatus) =>
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
test("compaction needs a verified read and fresh acknowledgement, persists intent before exactly one POST, and displays exact completion", async () => {
  const stored = storage();
  let calls = 0,
    finish = (_value: Response) => {};
  const client = createLedgerCompactionClient({
    storage: stored,
    canAct: () => true,
    changed() {},
    requestId: () => id,
    read: async () => answer(ready),
    post: async (request: LedgerCompactionRequest) => {
      calls++;
      expect(stored.getItem()).toBe(JSON.stringify(request));
      return new Promise<Response>((done) => {
        finish = done;
      });
    },
  });
  expect(calls).toBe(0);
  await client.compact();
  await client.check();
  await client.compact();
  expect(calls).toBe(0);
  client.acknowledge(true);
  const pending = client.compact();
  void client.compact();
  expect(calls).toBe(1);
  expect(client.state.busy).toBe(true);
  finish(answer(completed));
  await pending;
  expect(client.state).toMatchObject({
    busy: false,
    acknowledged: false,
    pending: null,
    fresh: true,
    data: completed,
  });
  expect(stored.getItem()).toBeNull();
  await client.compact();
  expect(calls).toBe(1);
});
test("lost replies survive navigation/reload; ready, wrong-target, wrong-operation and superseded receipts never clear the old intent", async () => {
  const stored = storage();
  let calls = 0,
    current = ready;
  const deps = {
    storage: stored,
    requestId: () => id,
    canAct: () => true,
    changed() {},
    read: async () => answer(current),
    post: async () => {
      calls++;
      throw Error("PRIVATE_TRANSPORT");
    },
  };
  const old = createLedgerCompactionClient(deps);
  await old.check();
  old.acknowledge(true);
  await old.compact();
  old.dispose();
  expect(calls).toBe(1);
  expect(stored.getItem()).not.toBeNull();
  const fresh = createLedgerCompactionClient(deps);
  for (const data of [
    ready,
    {
      ...completed,
      record: { ...completed.record, ledgerKey: "b".repeat(64) },
    },
    { ...completed, record: { ...completed.record, revision: 2 } },
    {
      ...completed,
      record: {
        ...completed.record,
        last: {
          ...completed.record.last!,
          requestId: "ac000000-0000-4000-8000-000000000002",
        },
      },
    },
  ]) {
    current = data;
    await fresh.check();
    fresh.acknowledge(true);
    await fresh.compact();
    expect(fresh.state.pending?.requestId).toBe(id);
    expect(fresh.canCompact()).toBe(false);
    expect(calls).toBe(1);
  }
  current = completed;
  await fresh.check();
  expect(fresh.state.pending).toBeNull();
  expect(stored.getItem()).toBeNull();
  expect(fresh.canCompact()).toBe(true);
  expect(fresh.state.acknowledged).toBe(false);
  expect(calls).toBe(1);
});
test("explicit pre-effect refusal needs a fresh read and acknowledgement; malformed or missing reads keep stale facts", async () => {
  let response = answer(ready),
    calls = 0;
  const client = createLedgerCompactionClient({
    storage: storage(),
    requestId: () => id,
    canAct: () => true,
    changed() {},
    read: async () => response,
    post: async () => {
      calls++;
      return Response.json(
        { ok: false, data: null, error: "not echoed" },
        { status: 409 },
      );
    },
  });
  await client.check();
  client.acknowledge(true);
  await client.compact();
  expect(client.state.pending).toBeNull();
  expect(client.state.fresh).toBe(false);
  expect(client.canCompact()).toBe(false);
  expect(client.state.error).toContain("refused");
  response = Response.json({
    ok: true,
    data: { canCompact: true },
    error: null,
  });
  await client.check();
  expect(client.state.data).toEqual(ready);
  expect(client.state.fresh).toBe(false);
  expect(calls).toBe(1);
});
test("unavailable or corrupt intent storage and failed preservation disable mutation without deleting evidence", async () => {
  for (const stored of [
    null,
    {
      getItem: () => "{broken",
      setItem() {},
      removeItem() {
        throw Error("MUST_NOT_DELETE");
      },
    },
    {
      getItem: () => null,
      setItem() {
        throw Error("PRIVATE_STORAGE");
      },
      removeItem() {},
    },
  ]) {
    let calls = 0;
    const client = createLedgerCompactionClient({
      storage: stored,
      requestId: () => id,
      canAct: () => true,
      changed() {},
      read: async () => answer(ready),
      post: async () => {
        calls++;
        return answer(completed);
      },
    });
    await client.check();
    client.acknowledge(true);
    await client.compact();
    expect(calls).toBe(0);
    expect(client.canCompact()).toBe(false);
    expect(JSON.stringify(client.state)).not.toContain("PRIVATE");
  }
});
test("disposed pending actions retain intent for a fresh consumer and never publish a late result", async () => {
  const stored = storage();
  let finish = (_value: Response) => {},
    changes = 0;
  const deps = {
    storage: stored,
    requestId: () => id,
    canAct: () => true,
    changed() {
      changes++;
    },
    read: async () => answer(completed),
    post: async () =>
      new Promise<Response>((done) => {
        finish = done;
      }),
  };
  const client = createLedgerCompactionClient({
    ...deps,
    read: async () => answer(ready),
  });
  await client.check();
  client.acknowledge(true);
  const pending = client.compact();
  client.dispose();
  const before = changes;
  finish(answer(completed));
  await pending;
  expect(changes).toBe(before);
  expect(stored.getItem()).not.toBeNull();
  const fresh = createLedgerCompactionClient(deps);
  await fresh.check();
  expect(fresh.state.pending).toBeNull();
  expect(stored.getItem()).toBeNull();
});
test("the view explains machine-wide data loss, exposes a cancellable labelled acknowledgement and keeps unavailable controls disabled", () => {
  const client = createLedgerCompactionClient({
    storage: storage(),
    requestId: () => id,
    canAct: () => false,
    changed() {},
    read: async () => answer(ready),
    post: async () => answer(completed),
  });
  const view = LedgerCompactionView({
    state: client.state,
    ready: false,
    connected: false,
    check() {},
    acknowledge() {},
    compact() {},
  });
  expect(textOf(view)).toContain("all workspaces");
  expect(textOf(view)).toContain("not an immutable recovery copy");
  expect(attrs(findAll(view, "input")[0])["type"]).toBe("checkbox");
  for (const button of findAll(view, "button"))
    expect(attrs(button)["disabled"]).toBe(true);
  expect(findAll(view, "label")).toHaveLength(1);
});
test("a syntactically valid receipt with a contradictory cutoff or impossible counts is not verified", async () => {
  for (const last of [
    { ...completed.record.last!, cutoffAt: "2026-11-09T12:00:00Z" },
    { ...completed.record.last!, events: 0, days: 1 },
  ]) {
    const client = createLedgerCompactionClient({
      storage: storage(),
      requestId: () => id,
      canAct: () => true,
      changed() {},
      read: async () =>
        answer({ ...completed, record: { ...completed.record, last } }),
      post: async () => answer(completed),
    });
    await client.check();
    expect(client.state.fresh).toBe(false);
    expect(client.canCompact()).toBe(false);
  }
});
