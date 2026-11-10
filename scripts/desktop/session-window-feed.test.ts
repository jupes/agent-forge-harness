import { expect, test } from "bun:test";
import {
  readSessionWindowPage,
  sessionWindowFeed,
} from "../../apps/desktop/src/session-window-feed";
import type { StreamHandlers } from "../../docs/js/use-stream";
import type { ConversationPage } from "../../types/conversation";

const projectId = "project-11111111-1111-4111-8111-111111111111";
const sessionId = "session-22222222-2222-4222-8222-222222222222";
const page = (): ConversationPage => ({
  version: 1,
  projectId,
  conversationId: sessionId,
  revision: 0,
  binding: null,
  turns: [],
  frames: [],
  more: false,
  lastSequence: 0,
  nextCursor: 0,
  request: null,
  controllable: false,
});
test("compact reads unwrap the real API envelope under the protected byte and cancellation limits", async () => {
  const controller = new AbortController();
  let receiving: AbortSignal | null | undefined;
  const actual = await readSessionWindowPage(
    "/projects/exact/sessions/exact?after=0&limit=100",
    controller.signal,
    async (input, init, options) => {
      expect(input).toBe(
        "/__agent-forge/projects/exact/sessions/exact?after=0&limit=100",
      );
      expect(options?.maxBodyBytes).toBe(8 * 1024 * 1024);
      receiving = init?.signal;
      return Response.json({ ok: true, data: page(), error: null });
    },
    { staticCopy: false },
  );
  expect(actual).toEqual(page());
  controller.abort();
  expect(receiving!.aborted).toBe(true);
  for (const [status, body] of [
    [503, { ok: true, data: page(), error: null }],
    [200, { ok: false, data: null, error: "Refused" }],
    [200, { data: page() }],
  ] as const) {
    await expect(
      readSessionWindowPage(
        "/projects/exact/sessions/exact",
        new AbortController().signal,
        async () => Response.json(body, { status }),
        { staticCopy: false },
      ),
    ).rejects.toThrow();
  }
  let staticReads = 0;
  await expect(
    readSessionWindowPage(
      "/projects/exact/sessions/exact",
      new AbortController().signal,
      async () => {
        staticReads++;
        return Response.json({ ok: true, data: page(), error: null });
      },
      { staticCopy: true },
    ),
  ).rejects.toThrow("static copy");
  expect(staticReads).toBe(0);
});
function clock() {
  const jobs = new Map<number, { run(): void; ms: number }>();
  let next = 0;
  return {
    jobs,
    set(run: () => void, ms: number) {
      const key = ++next;
      jobs.set(key, { run, ms });
      return key;
    },
    clear(key: unknown) {
      if (typeof key === "number") jobs.delete(key);
    },
    tick() {
      const [key, job] = jobs.entries().next().value ?? [];
      if (!job) throw Error("No timer");
      jobs.delete(key!);
      job.run();
    },
  };
}
const drain = async () => {
  for (let n = 0; n < 8; n++) await Promise.resolve();
};
function events() {
  const received: unknown[] = [];
  const handlers: StreamHandlers = {
    onOpen() {
      received.push("open");
    },
    onActivity() {
      received.push("activity");
    },
    onMessage(message) {
      let raw: unknown;
      try {
        raw = JSON.parse(message.data);
      } catch {
        throw Error("Bad feed JSON");
      }
      received.push(raw);
    },
    onEnd(outcome) {
      received.push(outcome);
    },
  };
  return { received, handlers };
}
test("compact feed serially reads real pages and releases its connection between checks", async () => {
  const timers = clock(),
    log = events(),
    calls: number[] = [];
  let finish!: (raw: unknown) => void;
  const pending = new Promise<unknown>((resolve) => {
    finish = resolve;
  });
  const feed = sessionWindowFeed({
    projectId,
    sessionId,
    timers,
    read: async (after) => {
      calls.push(after);
      return calls.length === 1 ? pending : page();
    },
  });
  const connection = feed(0, log.handlers);
  expect(calls).toEqual([0]);
  expect(timers.jobs.size).toBe(0);
  expect(log.received).toEqual([]);
  finish(page());
  await drain();
  expect(log.received).toEqual(["open", "activity", page()]);
  expect([...timers.jobs.values()].map((job) => job.ms)).toEqual([1000]);
  timers.tick();
  await drain();
  expect(calls).toEqual([0, 0]);
  expect(log.received).toEqual([
    "open",
    "activity",
    page(),
    "activity",
    page(),
  ]);
  connection.close();
  expect(timers.jobs.size).toBe(0);
});
test("closing a pending compact read aborts it and suppresses late pages and callbacks", async () => {
  const timers = clock(),
    log = events();
  let signal: AbortSignal | null = null,
    finish!: (raw: unknown) => void;
  const feed = sessionWindowFeed({
    projectId,
    sessionId,
    timers,
    read: (_after, active) => {
      signal = active;
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
  });
  const connection = feed(0, log.handlers);
  connection.close();
  connection.close();
  expect(signal!.aborted).toBe(true);
  finish(page());
  await drain();
  expect(log.received).toEqual([]);
  expect(timers.jobs.size).toBe(0);
});
test("unverified identity, malformed pages, stale revisions and cursor regressions end once without synthetic activity", async () => {
  for (const invalid of [
    null,
    { ...page(), projectId: "foreign" },
    { ...page(), conversationId: "foreign" },
    { ...page(), more: true },
    { ...page(), nextCursor: 1 },
  ]) {
    const timers = clock(),
      log = events();
    sessionWindowFeed({
      projectId,
      sessionId,
      timers,
      read: async () => invalid,
    })(0, log.handlers);
    await drain();
    expect(log.received).toEqual(["failed"]);
    expect(timers.jobs.size).toBe(0);
  }
  const timers = clock(),
    log = events();
  let count = 0;
  sessionWindowFeed({
    projectId,
    sessionId,
    timers,
    read: async () => ({ ...page(), revision: count++ === 0 ? 2 : 1 }),
  })(0, log.handlers);
  await drain();
  timers.tick();
  await drain();
  expect(log.received).toEqual([
    "open",
    "activity",
    { ...page(), revision: 2 },
    "failed",
  ]);
  expect(timers.jobs.size).toBe(0);
});

test("compact feed catches up at most 200 pages then delegates failure to its existing retry owner", async () => {
  const timers = clock(),
    log = events();
  let reads = 0;
  sessionWindowFeed({
    projectId,
    sessionId,
    timers,
    read: async (after) => {
      reads++;
      return {
        ...page(),
        revision: 1,
        nextCursor: after + 1,
        lastSequence: 201,
        more: true,
        frames: [
          {
            seq: after + 1,
            turnId: "33333333-3333-4333-8333-333333333333",
            at: "2026-11-10T00:00:00.000Z",
            event: { kind: "text", text: "Actual bounded frame" },
          },
        ],
      };
    },
  })(0, log.handlers);
  for (let n = 0; n < 220; n++) await Promise.resolve();
  expect(reads).toBe(200);
  expect(log.received.filter((item) => item === "open")).toHaveLength(1);
  expect(log.received.filter((item) => item === "failed")).toHaveLength(1);
  expect(log.received.filter((item) => typeof item === "object")).toHaveLength(
    200,
  );
  expect(timers.jobs.size).toBe(0);
});

test("transport failure emits no activity and schedules no independent retries", async () => {
  const timers = clock(),
    log = events();
  let calls = 0;
  sessionWindowFeed({
    projectId,
    sessionId,
    timers,
    read: async () => {
      calls++;
      throw Error("Lost protected answer");
    },
  })(0, log.handlers);
  await drain();
  expect(calls).toBe(1);
  expect(log.received).toEqual(["failed"]);
  expect(timers.jobs.size).toBe(0);
});

test("a synchronous close from activity suppresses the page callback", async () => {
  const timers = clock(),
    log = events();
  let connection: { close(): void };
  connection = sessionWindowFeed({
    projectId,
    sessionId,
    timers,
    read: async () => page(),
  })(0, {
    ...log.handlers,
    onActivity() {
      connection.close();
    },
  });
  await drain();
  expect(log.received).toEqual(["open"]);
  expect(timers.jobs.size).toBe(0);
});
