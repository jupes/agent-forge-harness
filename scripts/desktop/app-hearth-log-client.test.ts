import { expect, test } from "bun:test";
import { createHearthLogClient } from "../../apps/desktop/src/app-hearth-log-client";
import type { HearthLogSnapshot } from "./app-hearth-log-protocol";

const initial: HearthLogSnapshot = {
  version: 1,
  generation: "ae000000-0000-4000-8000-000000000001",
  startedAt: "2026-11-11T00:00:00Z",
  checkedAt: "2026-11-11T00:00:01Z",
  latestSequence: 2,
  retainedCount: 2,
  evictedCount: 0,
  omittedRetainedCount: 0,
  entries: [
    {
      sequence: 1,
      at: "2026-11-11T00:00:00Z",
      code: "runtime.created",
      level: "info",
      eventKind: null,
    },
    {
      sequence: 2,
      at: "2026-11-11T00:00:01Z",
      code: "ledger.failed",
      level: "warning",
      eventKind: "operator.action",
    },
  ],
};
const answer = (data: HearthLogSnapshot) =>
  Response.json({ ok: true, data, error: null });
test("log checks preserve the warning filter and last verified rows across failed refreshes", async () => {
  let fail = false,
    reads = 0;
  const client = createHearthLogClient({
    canRead: () => true,
    changed() {},
    read: async () => {
      reads++;
      if (fail) throw Error("private transport error");
      return answer(initial);
    },
  });
  expect(reads).toBe(0);
  await client.check();
  client.filter("warnings");
  expect(client.rows().map((row) => row.code)).toEqual(["ledger.failed"]);
  fail = true;
  await client.check();
  expect(client.state.data).toEqual(initial);
  expect(client.state.filter).toBe("warnings");
  expect(client.state.fresh).toBe(false);
  expect(client.state.error).not.toContain("private transport error");
  expect(client.rows()).toHaveLength(1);
});

test("a new lifetime replaces rows explicitly while retaining the selected filter", async () => {
  let current = initial;
  const client = createHearthLogClient({
    canRead: () => true,
    changed() {},
    read: async () => answer(current),
  });
  await client.check();
  client.filter("warnings");
  current = {
    ...initial,
    generation: "ae000000-0000-4000-8000-000000000002",
    latestSequence: 1,
    retainedCount: 1,
    entries: [initial.entries[0]!],
  };
  await client.check();
  expect(client.state.lifetimeChanged).toBe(true);
  expect(client.state.previousGeneration).toBe(initial.generation);
  expect(client.state.data?.generation).toBe(current.generation);
  expect(client.state.filter).toBe("warnings");
  expect(client.rows()).toEqual([]);
});

test("regressed and rewritten entries cannot replace a verified snapshot", async () => {
  let current = initial;
  const client = createHearthLogClient({
    canRead: () => true,
    changed() {},
    read: async () => answer(current),
  });
  await client.check();
  current = {
    ...initial,
    latestSequence: 1,
    retainedCount: 1,
    entries: [initial.entries[0]!],
  };
  await client.check();
  expect(client.state.data).toEqual(initial);
  expect(client.state.fresh).toBe(false);
  current = {
    ...initial,
    entries: [
      initial.entries[0]!,
      { ...initial.entries[1]!, code: "ledger.inserted", level: "info" },
    ],
  };
  await client.check();
  expect(client.state.data).toEqual(initial);
  expect(client.state.fresh).toBe(false);
  current = {
    ...initial,
    latestSequence: 3,
    retainedCount: 3,
    entries: [
      ...initial.entries,
      {
        sequence: 3,
        at: initial.checkedAt,
        code: "ledger.inserted",
        level: "info",
        eventKind: "operator.action",
      },
    ],
  };
  await client.check();
  expect(client.state.data).toEqual(current);
  expect(client.state.fresh).toBe(true);
});

test("reads are one flight and a retired owner cancels its late body", async () => {
  let reads = 0,
    finish = (_response: Response) => {},
    cancelled = false;
  const held = new Promise<Response>((done) => {
    finish = done;
  });
  const client = createHearthLogClient({
    canRead: () => true,
    changed() {},
    read: async () => {
      reads++;
      return held;
    },
  });
  const checking = client.check();
  await client.check();
  expect(reads).toBe(1);
  client.dispose();
  finish(
    new Response(
      new ReadableStream({
        cancel() {
          cancelled = true;
        },
      }),
    ),
  );
  await checking;
  expect(cancelled).toBe(true);
  expect(client.state.data).toBeNull();
});

test("unsupported and malformed snapshots stay unavailable rather than empty", async () => {
  let response = new Response("unsupported", { status: 404 });
  const client = createHearthLogClient({
    canRead: () => true,
    changed() {},
    read: async () => response,
  });
  await client.check();
  expect(client.state.unsupported).toBe(true);
  expect(client.state.data).toBeNull();
  response = answer({
    ...initial,
    retainedCount: 0,
    evictedCount: 2,
    entries: [],
  });
  await client.check();
  expect(client.state.data).toBeNull();
  expect(client.state.fresh).toBe(false);
});
