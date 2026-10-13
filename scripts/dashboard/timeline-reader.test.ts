import { describe, expect, test } from "bun:test";
import type { TimelineScope } from "../../docs/js/timeline-model";
import {
  narrowing,
  startTimelineRead,
  type TimelineView,
} from "../../docs/js/timeline-reader";
import type { WatchReason } from "../../docs/js/use-stream";
import type {
  EventsPage,
  LedgerEvent,
  LedgerEventKind,
} from "../../types/hearth";

/**
 * A ledger that answers `/events` as the hearth does: `bead` joins every event
 * of a session that has tagged the bead (worked out when the read is made, as
 * the query's subquery is), `kind` keeps the kinds of a comma list, `after`
 * pages forward, `more` says whether more matched, `cursor` is the last id or
 * the `after` asked for.
 */
function fakeLedger() {
  const events: LedgerEvent[] = [];
  const paths: string[] = [];
  let nextId = 1;
  let failing: string | null = null;
  let held: { open: () => void; promise: Promise<void> } | null = null;
  let beforeRead: ((count: number) => void) | null = null;

  const add = (more: Partial<LedgerEvent> = {}): LedgerEvent => {
    const event = {
      id: nextId++,
      ulid: `u${nextId}`,
      ts: "2026-10-12T00:00:00.000Z",
      kind: "tool.called",
      workspace: "/w",
      payload: { tool: "Bash", argsHash: "h" },
      ...more,
    } as LedgerEvent;
    events.push(event);
    return event;
  };

  const answer = (path: string): EventsPage => {
    const params = new URLSearchParams(path.slice(path.indexOf("?") + 1));
    const bead = params.get("bead");
    const run = params.get("run");
    const session = params.get("session");
    const kinds = params.get("kind")?.split(",") ?? null;
    const after = Number(params.get("after") ?? "0");
    const limit = Number(params.get("limit") ?? "200");
    const joined = new Set(
      events
        .filter((entry) => bead !== null && entry.beadId === bead)
        .flatMap((entry) => (entry.sessionId ? [entry.sessionId] : [])),
    );
    const matching = events.filter(
      (entry) =>
        entry.id > after &&
        (bead === null ||
          entry.beadId === bead ||
          (entry.sessionId !== undefined && joined.has(entry.sessionId))) &&
        (run === null || entry.runId === run) &&
        (session === null || entry.sessionId === session) &&
        (kinds === null || kinds.includes(entry.kind)),
    );
    const page = matching.slice(0, limit);
    return {
      events: page,
      cursor: page.at(-1)?.id ?? after,
      more: matching.length > limit,
    };
  };

  return {
    events,
    paths,
    add,
    /** Every event from here on is answered as a new ledger would be. */
    replace(): void {
      events.length = 0;
    },
    failWith(message: string | null): void {
      failing = message;
    },
    /** The next read waits until `release` is called. */
    hold(): () => void {
      let open: () => void = () => undefined;
      const promise = new Promise<void>((resolve) => {
        open = resolve;
      });
      held = { open, promise };
      return open;
    },
    onRead(run: (count: number) => void): void {
      beforeRead = run;
    },
    async read(path: string): Promise<EventsPage> {
      paths.push(path);
      beforeRead?.(paths.length);
      const gate = held;
      held = null;
      if (gate) await gate.promise;
      if (failing !== null) throw new Error(failing);
      return answer(path);
    },
  };
}

function fakeClient() {
  const callbacks: Array<(reason: WatchReason) => void> = [];
  return {
    watch(_kinds: unknown, callback: (reason: WatchReason) => void) {
      callbacks.push(callback);
      return () => undefined;
    },
    tell(reason: WatchReason): void {
      for (const callback of callbacks) callback(reason);
    },
  };
}

/** Let every pending read and refetch run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

function start(
  scope: TimelineScope,
  ledger: ReturnType<typeof fakeLedger>,
  cap?: number,
  kinds?: LedgerEventKind[],
) {
  const client = fakeClient();
  const views: TimelineView[] = [];
  let clock = 0;
  const stop = startTimelineRead({
    scope,
    read: (path) => ledger.read(path),
    client,
    onChange: (view) => views.push(view),
    // Every ask starts at once: the refetch window is not under test here.
    now: () => (clock += 10_000),
    ...(cap !== undefined ? { cap } : {}),
    ...(kinds !== undefined ? { kinds } : {}),
  });
  return {
    client,
    views,
    stop,
    last: (): TimelineView => {
      const view = views.at(-1);
      if (!view) throw new Error("nothing published yet");
      return view;
    },
  };
}

const ids = (view: TimelineView): number[] =>
  view.events.map((entry) => entry.id);
const range = (from: number, to: number): number[] =>
  Array.from({ length: to - from + 1 }, (_, index) => from + index);
const RUN: TimelineScope = { by: "run", id: "r" };
const BEAD: TimelineScope = { by: "bead", id: "b" };

describe("the first read", () => {
  test("pages forward until the ledger has no more, showing each page as it arrives", async () => {
    const ledger = fakeLedger();
    for (let index = 0; index < 2500; index++) ledger.add({ runId: "r" });
    const timeline = start(RUN, ledger);
    await settle();
    expect(ledger.paths).toEqual([
      "/events?run=r&after=0&limit=1000",
      "/events?run=r&after=1000&limit=1000",
      "/events?run=r&after=2000&limit=1000",
    ]);
    expect(timeline.views.map((view) => view.events.length)).toEqual([
      1000, 2000, 2500,
    ]);
    expect(timeline.views.map((view) => view.loading)).toEqual([
      true,
      true,
      false,
    ]);
    expect(timeline.last().cut).toBe(false);
  });

  test("past the cap it reads on to the end, holds the newest and says it cut", async () => {
    const ledger = fakeLedger();
    for (let index = 0; index < 2500; index++) ledger.add({ runId: "r" });
    const timeline = start(RUN, ledger, 1500);
    await settle();
    expect(ledger.paths).toEqual([
      "/events?run=r&after=0&limit=1000",
      "/events?run=r&after=1000&limit=1000",
      "/events?run=r&after=2000&limit=1000",
    ]);
    expect(ids(timeline.last())).toEqual(range(1001, 2500));
    expect(timeline.last()).toMatchObject({ cut: true, loading: false });
  });

  test("every kind read is named, also one whose events the cap no longer holds", async () => {
    const ledger = fakeLedger();
    ledger.add({ runId: "r", kind: "session.started", payload: {} });
    for (let index = 0; index < 2500; index++) ledger.add({ runId: "r" });
    const timeline = start(RUN, ledger, 1500);
    await settle();
    const held = new Set(timeline.last().events.map((entry) => entry.kind));
    expect([...held]).toEqual(["tool.called"]);
    expect(timeline.last().kindsRead).toEqual([
      "session.started",
      "tool.called",
    ]);
  });
});

describe("following the ledger", () => {
  test("new events are read past the cursor and appended", async () => {
    const ledger = fakeLedger();
    ledger.add({ runId: "r" });
    ledger.add({ runId: "r" });
    const timeline = start(RUN, ledger);
    await settle();
    ledger.add({ runId: "r" });
    ledger.add({ runId: "other" });
    timeline.client.tell("events");
    await settle();
    expect(ledger.paths.at(-1)).toBe("/events?run=r&after=2&limit=1000");
    expect(ids(timeline.last())).toEqual([1, 2, 3]);
  });

  test("a follow read pages until the ledger has no more", async () => {
    const ledger = fakeLedger();
    ledger.add({ runId: "r" });
    const timeline = start(RUN, ledger);
    await settle();
    for (let index = 0; index < 1500; index++) ledger.add({ runId: "r" });
    timeline.client.tell("events");
    await settle();
    expect(ledger.paths.slice(1)).toEqual([
      "/events?run=r&after=1&limit=1000",
      "/events?run=r&after=1001&limit=1000",
    ]);
    expect(ids(timeline.last())).toEqual(range(1, 1501));
  });

  test("once the list was cut, new events are still read and the oldest held make way", async () => {
    const ledger = fakeLedger();
    for (let index = 0; index < 3; index++) ledger.add({ runId: "r" });
    const timeline = start(RUN, ledger, 2);
    await settle();
    expect(ids(timeline.last())).toEqual([2, 3]);
    ledger.add({ runId: "r" });
    timeline.client.tell("events");
    await settle();
    expect(ledger.paths.at(-1)).toBe("/events?run=r&after=3&limit=1000");
    expect(ids(timeline.last())).toEqual([3, 4]);
    expect(timeline.last().cut).toBe(true);
  });

  test("stopping ends the reads", async () => {
    const ledger = fakeLedger();
    ledger.add({ runId: "r" });
    const timeline = start(RUN, ledger);
    await settle();
    timeline.stop();
    const reads = ledger.paths.length;
    timeline.client.tell("events");
    await settle();
    expect(ledger.paths).toHaveLength(reads);
  });
});

const sessionReads = (paths: readonly string[]): string[] =>
  paths.filter((path) => path.includes("session="));

describe("a session that joins the bead later", () => {
  test("its older events, read before it touched the bead, are brought in when it does", async () => {
    const ledger = fakeLedger();
    ledger.add({ sessionId: "s", kind: "session.started", payload: {} });
    ledger.add({ sessionId: "s" });
    ledger.add({ beadId: "b", sessionId: "t" });
    const timeline = start(BEAD, ledger);
    await settle();
    expect(ids(timeline.last())).toEqual([3]);

    ledger.add({ beadId: "b", sessionId: "s" });
    timeline.client.tell("events");
    await settle();
    expect(sessionReads(ledger.paths)).toEqual([
      "/events?session=s&after=0&limit=1",
      "/events?session=s&after=0&limit=1000",
    ]);
    expect(ids(timeline.last())).toEqual([1, 2, 3, 4]);
  });

  test("one tagged from its first event is asked about once and nothing more is read", async () => {
    const ledger = fakeLedger();
    ledger.add({ beadId: "b", sessionId: "t" });
    const timeline = start(BEAD, ledger);
    await settle();
    ledger.add({ beadId: "b", sessionId: "host:agent" });
    ledger.add({ sessionId: "host:agent" });
    timeline.client.tell("events");
    await settle();
    expect(sessionReads(ledger.paths)).toEqual([
      "/events?session=host%3Aagent&after=0&limit=1",
    ]);
    expect(ids(timeline.last())).toEqual([1, 2, 3]);
  });

  test("each one that brings older events in is counted; one tagged from its first event is not", async () => {
    const ledger = fakeLedger();
    ledger.add({ sessionId: "s" });
    ledger.add({ beadId: "b", sessionId: "t" });
    const timeline = start(BEAD, ledger);
    await settle();
    expect(timeline.last().lateJoins).toBe(0);
    ledger.add({ beadId: "b", sessionId: "fresh" });
    timeline.client.tell("events");
    await settle();
    expect(timeline.last().lateJoins).toBe(0);
    ledger.add({ beadId: "b", sessionId: "s" });
    timeline.client.tell("events");
    await settle();
    expect(ids(timeline.last())).toEqual([1, 2, 3, 4]);
    expect(timeline.last().lateJoins).toBe(1);
  });

  test("a session already shown is not asked about again", async () => {
    const ledger = fakeLedger();
    ledger.add({ beadId: "b", sessionId: "t" });
    const timeline = start(BEAD, ledger);
    await settle();
    ledger.add({ sessionId: "t" });
    timeline.client.tell("events");
    await settle();
    expect(sessionReads(ledger.paths)).toEqual([]);
    expect(ids(timeline.last())).toEqual([1, 2]);
  });

  test("a run's timeline never asks about sessions", async () => {
    const ledger = fakeLedger();
    ledger.add({ runId: "r", sessionId: "s" });
    const timeline = start(RUN, ledger);
    await settle();
    ledger.add({ runId: "r", sessionId: "u" });
    timeline.client.tell("events");
    await settle();
    expect(sessionReads(ledger.paths)).toEqual([]);
    expect(ids(timeline.last())).toEqual([1, 2]);
  });

  test("on a later page of the first read: one that touched the bead between two pages is brought in whole", async () => {
    const ledger = fakeLedger();
    ledger.add({ sessionId: "late" });
    ledger.add({ sessionId: "late" });
    for (let index = 0; index < 1500; index++) ledger.add({ beadId: "b" });
    // Between the first page and the second, the session touches the bead.
    ledger.onRead((count) => {
      if (count === 2) ledger.add({ beadId: "b", sessionId: "late" });
    });
    const timeline = start(BEAD, ledger);
    await settle();
    expect(sessionReads(ledger.paths)).toEqual([
      "/events?session=late&after=0&limit=1",
      "/events?session=late&after=0&limit=1000",
    ]);
    expect(ids(timeline.last())).toEqual([1, 2, ...range(3, 1503)]);
  });

  test("on the first page of the first read: whole already, and not asked about", async () => {
    const ledger = fakeLedger();
    ledger.add({ sessionId: "early" });
    ledger.add({ beadId: "b", sessionId: "early" });
    const timeline = start(BEAD, ledger);
    await settle();
    expect(sessionReads(ledger.paths)).toEqual([]);
    expect(ids(timeline.last())).toEqual([1, 2]);
  });

  test("a follow read of several pages: one that touched the bead between them is brought in whole", async () => {
    const ledger = fakeLedger();
    ledger.add({ beadId: "b" });
    const timeline = start(BEAD, ledger);
    await settle();
    ledger.add({ sessionId: "mid" });
    for (let index = 0; index < 1200; index++) ledger.add({ beadId: "b" });
    const before = ledger.paths.length;
    ledger.onRead((count) => {
      if (count === before + 2) ledger.add({ beadId: "b", sessionId: "mid" });
    });
    timeline.client.tell("events");
    await settle();
    expect(ids(timeline.last())).toEqual(range(1, 1203));
  });
});

describe("when the stream reopens", () => {
  test("the history is read again from the start and replaces the list", async () => {
    const ledger = fakeLedger();
    ledger.add({ runId: "r" });
    ledger.add({ runId: "r" });
    const timeline = start(RUN, ledger);
    await settle();
    // The ledger was replaced while the stream was away: the old ids are gone.
    ledger.replace();
    ledger.add({ runId: "r" });
    timeline.client.tell("resync");
    await settle();
    expect(ledger.paths.at(-1)).toBe("/events?run=r&after=0&limit=1000");
    expect(ids(timeline.last())).toEqual([3]);
  });

  test("a reopen while a follow read is out is still read from the start", async () => {
    const ledger = fakeLedger();
    ledger.add({ runId: "r" });
    const timeline = start(RUN, ledger);
    await settle();
    ledger.add({ runId: "r" });
    const release = ledger.hold();
    timeline.client.tell("events");
    await settle();
    ledger.replace();
    ledger.add({ runId: "r" });
    timeline.client.tell("resync");
    timeline.client.tell("events");
    release();
    await settle();
    expect(ledger.paths.at(-1)).toBe("/events?run=r&after=0&limit=1000");
    expect(ids(timeline.last())).toEqual([3]);
  });
});

describe("a read that fails", () => {
  test("the first: no events, and the reason", async () => {
    const ledger = fakeLedger();
    ledger.failWith("the hearth is away");
    const timeline = start(RUN, ledger);
    await settle();
    expect(timeline.last()).toMatchObject({
      events: [],
      loading: false,
      error: "the hearth is away",
    });
  });

  test("a later one keeps what is shown and says why; the next that works clears it", async () => {
    const ledger = fakeLedger();
    ledger.add({ runId: "r" });
    const timeline = start(RUN, ledger);
    await settle();
    ledger.failWith("the hearth is away");
    ledger.add({ runId: "r" });
    timeline.client.tell("events");
    await settle();
    expect(timeline.last()).toMatchObject({ error: "the hearth is away" });
    expect(ids(timeline.last())).toEqual([1]);
    ledger.failWith(null);
    timeline.client.tell("events");
    await settle();
    expect(timeline.last().error).toBeNull();
    expect(ids(timeline.last())).toEqual([1, 2]);
  });

  test("after a first read that failed, the next ask reads from the start", async () => {
    const ledger = fakeLedger();
    ledger.failWith("away");
    ledger.add({ runId: "r" });
    const timeline = start(RUN, ledger);
    await settle();
    ledger.failWith(null);
    timeline.client.tell("events");
    await settle();
    expect(ledger.paths.at(-1)).toBe("/events?run=r&after=0&limit=1000");
    expect(ids(timeline.last())).toEqual([1]);
  });
});

describe("a session probe that fails", () => {
  test("is tried again on the next read, so the session's older events still come in", async () => {
    const ledger = fakeLedger();
    ledger.add({ sessionId: "s" });
    ledger.add({ beadId: "b", sessionId: "t" });
    const timeline = start(BEAD, ledger);
    await settle();
    ledger.add({ beadId: "b", sessionId: "s" });
    // The follow read answers; the probe after it does not.
    ledger.onRead((count) => {
      ledger.failWith(count === 3 ? "away" : null);
    });
    timeline.client.tell("events");
    await settle();
    expect(timeline.last().error).toBe("away");
    ledger.add({ beadId: "b" });
    timeline.client.tell("events");
    await settle();
    expect(timeline.last().error).toBeNull();
    expect(ids(timeline.last())).toEqual([1, 2, 3, 4]);
  });
});

describe("a read from the start after a reopen", () => {
  test("says it is still reading while its pages arrive", async () => {
    const ledger = fakeLedger();
    for (let index = 0; index < 1500; index++) ledger.add({ runId: "r" });
    const timeline = start(RUN, ledger);
    await settle();
    const before = timeline.views.length;
    timeline.client.tell("resync");
    await settle();
    expect(timeline.views.slice(before).map((view) => view.loading)).toEqual([
      true,
      false,
    ]);
  });
});

describe("a read narrowed to kinds", () => {
  test("asks the ledger for those kinds only, and holds every event of them in a scope past the cap", async () => {
    const ledger = fakeLedger();
    ledger.add({ runId: "r", kind: "session.started", payload: {} });
    for (let index = 0; index < 2500; index++) ledger.add({ runId: "r" });
    ledger.add({
      runId: "r",
      kind: "verdict.bound",
      payload: { verdict: "pass" },
    });
    const timeline = start(RUN, ledger, 1500, [
      "session.started",
      "verdict.bound",
    ]);
    await settle();
    expect(ledger.paths).toEqual([
      "/events?run=r&after=0&limit=1000&kind=session.started%2Cverdict.bound",
    ]);
    expect(ids(timeline.last())).toEqual([1, 2502]);
    expect(timeline.last().cut).toBe(false);
  });

  test("a session that joins the bead later brings in its older events of those kinds only", async () => {
    const ledger = fakeLedger();
    ledger.add({ sessionId: "s" });
    ledger.add({
      sessionId: "s",
      kind: "gate.ran",
      payload: { gate: "lint", passed: true },
    });
    ledger.add({ beadId: "b", sessionId: "t" });
    const timeline = start(BEAD, ledger, undefined, ["tool.called"]);
    await settle();
    expect(ids(timeline.last())).toEqual([3]);
    ledger.add({ beadId: "b", sessionId: "s" });
    timeline.client.tell("events");
    await settle();
    expect(sessionReads(ledger.paths)).toEqual([
      "/events?session=s&after=0&limit=1&kind=tool.called",
      "/events?session=s&after=0&limit=1000&kind=tool.called",
    ]);
    expect(ids(timeline.last())).toEqual([1, 3, 4]);
  });
});

describe("when chosen kinds are read from the ledger", () => {
  const view = (more: Partial<TimelineView> = {}): TimelineView => ({
    events: [],
    loading: false,
    cut: false,
    error: null,
    kindsRead: [],
    lateJoins: 0,
    ...more,
  });

  test("not while nothing is read yet, the list holds every event, or no kind is chosen", () => {
    expect(narrowing(null, ["gate.ran"])).toBeNull();
    expect(narrowing(view(), ["gate.ran"])).toBeNull();
    expect(narrowing(view({ cut: true }), [])).toBeNull();
  });

  test("once the list was cut: the chosen kinds, under a key that changes with them and with each late join", () => {
    const first = narrowing(view({ cut: true }), ["gate.ran"]);
    expect(first?.kinds).toEqual(["gate.ran"]);
    const joined = narrowing(view({ cut: true, lateJoins: 1 }), ["gate.ran"]);
    const other = narrowing(view({ cut: true }), ["gate.ran", "tool.called"]);
    expect(new Set([first?.key, joined?.key, other?.key]).size).toBe(3);
  });
});
