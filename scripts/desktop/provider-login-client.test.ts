import { expect, test } from "bun:test";
import { createProviderLoginClient } from "../../apps/desktop/src/provider-login-client";

const uuid = "9886feb7-0172-4a08-a306-d5b8b98cc36d",
  scope = "a".repeat(64);
const row = {
  provider: "claude",
  requestId: uuid,
  phase: "running",
  startedAt: "2026-10-23T08:00:00Z",
  endedAt: null,
  exitCode: null,
  stopped: false,
  timedOut: false,
} as const;
function fixture() {
  const values = new Map<string, string>(),
    calls: unknown[] = [];
  let tail = Promise.resolve();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
  const withLock = async <T>(work: () => T | Promise<T>) => {
    const before = tail;
    let done = () => {};
    tail = new Promise<void>((resolve) => {
      done = resolve;
    });
    await before;
    try {
      return await work();
    } finally {
      done();
    }
  };
  let current: unknown = null,
    lose = true;
  const make = () =>
    createProviderLoginClient({
      scope,
      storage,
      withLock,
      mint: () => uuid,
      changed: () => {},
      read: async (path) => {
        if (path === "/providers/sign-in")
          return { records: current ? [current] : [] };
        if (!current) throw Error("404 before original admission");
        return current;
      },
      post: async (path, body) => {
        expect([...values.values()].join()).toContain(uuid);
        calls.push({ path, body });
        if (lose) throw Error("Lost original response");
        current = row;
        return Response.json({ ok: true, data: row, error: null });
      },
    });
  return {
    values,
    storage,
    make,
    calls,
    setCurrent: (value: unknown) => {
      current = value;
    },
    allowReply: () => {
      lose = false;
    },
  };
}

test("two windows save one original sign-in identity before POST; reload and404 never permit a fresh launch", async () => {
  const f = fixture(),
    first = f.make(),
    second = f.make();
  await Promise.all([first.refresh(), second.refresh()]);
  await Promise.all([first.start("claude"), second.start("claude")]);
  expect(f.calls).toHaveLength(1);
  const reloaded = f.make();
  await reloaded.refresh();
  expect(reloaded.get("claude").identity?.requestId).toBe(uuid);
  await reloaded.start("claude");
  expect(f.calls).toHaveLength(1);
  f.allowReply();
  await reloaded.retry("claude");
  expect(f.calls).toHaveLength(2);
  expect(f.calls[0]).toEqual(f.calls[1]);
  expect(reloaded.get("claude").receipt?.phase).toBe("running");
});

test("storage failure refuses before any sign-in POST and never silently forgets a closed original", async () => {
  const f = fixture(),
    client = f.make();
  await client.refresh();
  f.storage.setItem = () => {
    throw Error("storage unavailable");
  };
  await client.start("claude");
  expect(f.calls).toHaveLength(0);
  expect(client.get("claude").notice).toContain("saved");
});

test("failure to erase a matched closed original retains its durable hold", async () => {
  const f = fixture(),
    client = f.make();
  await client.refresh();
  await client.start("claude");
  f.setCurrent({
    ...row,
    phase: "closed",
    endedAt: "2026-10-23T08:00:01Z",
    exitCode: 0,
  });
  const save = f.storage.setItem;
  f.storage.setItem = () => {
    throw Error("cannot erase original");
  };
  await client.check("claude");
  expect(client.get("claude").identity?.requestId).toBe(uuid);
  await client.start("claude");
  expect(f.calls).toHaveLength(1);
  f.storage.setItem = save;
  await client.check("claude");
  expect(client.get("claude").identity).toBeNull();
});

test("only a matching protected terminal receipt releases the held UUID; exit0 is not sign-in proof", async () => {
  const f = fixture(),
    client = f.make();
  await client.refresh();
  await client.start("claude");
  f.setCurrent({
    ...row,
    provider: "codex",
    phase: "closed",
    endedAt: "2026-10-23T08:00:01Z",
    exitCode: 0,
  });
  await client.check("claude");
  expect(client.get("claude").identity?.requestId).toBe(uuid);
  f.setCurrent({
    ...row,
    phase: "closed",
    endedAt: "2026-10-23T08:00:01Z",
    exitCode: 0,
  });
  await client.check("claude");
  expect(client.get("claude").identity).toBeNull();
  expect(client.get("claude").notice).toContain("Run doctor");
  expect(client.get("claude").notice).not.toContain("signed in");
});
