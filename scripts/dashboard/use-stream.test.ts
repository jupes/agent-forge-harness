import { describe, expect, test } from "bun:test";
import {
  applyDeltas,
  applySnapshot,
  INITIAL_LIVE_STATE,
  type LiveState,
  liveStats,
  MAX_LIVE_SESSIONS,
  withCollection,
  withStatus,
} from "../../docs/js/app-state";
import {
  LiveBannerView,
  LiveStatsView,
} from "../../docs/js/islands/LiveStatus";
import type { DevApiState } from "../../docs/js/use-dev-api";
import {
  BATCH_MAX,
  BATCH_MS,
  createRefetcher,
  createSseParser,
  createStreamClient,
  fetchTransport,
  MAX_FAILURES,
  REFETCH_WINDOW_MS,
  SILENCE_MS,
  type SseMessage,
  STABLE_MS,
  type StreamEnd,
  type StreamHandlers,
  type StreamTransport,
  startLiveRead,
  type Timers,
  type WatchReason,
} from "../../docs/js/use-stream";
import type {
  LedgerEvent,
  LedgerEventInput,
  OperatorEnvelope,
  Reservation,
  SessionSummary,
  StreamSnapshot,
} from "../../types/hearth";
import { activeRuns, type RunSummary } from "../forge/runs";
import { OPERATOR_HEADER } from "../hearth/paths";
import { startTestHearth } from "../hearth/testing";
import { attrs, findAll, tag, textOf } from "./ds/vnode";

/**
 * The dashboard's stream client: the state rules (`docs/js/app-state.ts`) and
 * the client that feeds them (`docs/js/use-stream.ts`).
 *
 * The client is driven by a stand-in transport and stand-in timers, so every
 * test decides what arrives and when. Two tests at the end use the real
 * transport against a real hearth: what a stand-in cannot show is that the
 * server skips the snapshot on a resume.
 */

const WORKSPACE = "c:/work/harness";

function ok<T>(data: T): OperatorEnvelope<T> {
  return { ok: true, data, error: null };
}

function failed<T>(error: string): OperatorEnvelope<T> {
  return { ok: false, data: null, error };
}

/** A stored event: `at` is seconds past a fixed minute, so order is readable. */
function event(
  id: number,
  input: Omit<LedgerEventInput, "workspace" | "ts">,
  at = id,
): LedgerEvent {
  // justification: the caller's kind and payload stay paired; only identity fields are added.
  return {
    ...input,
    id,
    ulid: `ulid-${id}`,
    ts: `2026-10-11T12:00:${String(at).padStart(2, "0")}.000Z`,
    workspace: WORKSPACE,
  } as LedgerEvent;
}

function run(slug: string, over: Partial<RunSummary> = {}): RunSummary {
  return {
    slug,
    phase: "research",
    completed: ["research"],
    next: "plan",
    halted: null,
    reviewPending: null,
    revising: false,
    complete: false,
    mode: "gated",
    feature: null,
    epic: null,
    checkout: null,
    updatedAt: "2026-10-11T12:00:00.000Z",
    ...over,
  };
}

function session(
  id: string,
  over: Partial<SessionSummary> = {},
): SessionSummary {
  return {
    sessionId: id,
    workspace: WORKSPACE,
    lastEventAt: "2026-10-11T11:00:00.000Z",
    ...over,
  };
}

function snapshot(over: Partial<StreamSnapshot> = {}): StreamSnapshot {
  return {
    cursor: 10,
    sessions: ok([]),
    runs: ok([]),
    queue: ok([]),
    reservations: ok([]),
    // justification: no rule under test reads the smiths or the config; they are carried as given.
    smiths: ok(
      {} as StreamSnapshot["smiths"] extends OperatorEnvelope<infer T>
        ? T
        : never,
    ),
    config: failed("no config in this test"),
    ...over,
  };
}

function live(over: Partial<StreamSnapshot> = {}): LiveState {
  return applySnapshot(INITIAL_LIVE_STATE, snapshot(over));
}

describe("state: snapshot", () => {
  test("nothing is known before a snapshot", () => {
    expect(INITIAL_LIVE_STATE.status).toBe("connecting");
    expect(INITIAL_LIVE_STATE.cursor).toBeNull();
    expect(INITIAL_LIVE_STATE.runs).toEqual({ data: null, error: null });
    expect(liveStats(INITIAL_LIVE_STATE)).toBeNull();
  });

  test("a snapshot replaces every collection, sets the cursor and goes live", () => {
    const runs = [run("alpha")];
    const state = live({ cursor: 42, runs: ok(runs) });
    expect(state.status).toBe("live");
    expect(state.offReason).toBeNull();
    expect(state.cursor).toBe(42);
    expect(state.runs).toEqual({ data: runs, error: null });
    expect(state.sessions).toEqual({ data: [], error: null });
  });

  test("a collection that could not be read is unknown and keeps its error", () => {
    const state = live({ queue: failed("bd is not installed") });
    expect(state.queue).toEqual({ data: null, error: "bd is not installed" });
    expect(liveStats(state)?.queued).toBeNull();
  });

  test("a later snapshot with a LOWER cursor still wins: the ledger was replaced", () => {
    const first = live({ cursor: 900, runs: ok([run("old")]) });
    const second = applySnapshot(first, snapshot({ cursor: 3 }));
    expect(second.cursor).toBe(3);
    expect(second.runs.data).toEqual([]);
    // What follows the new cursor applies, although it is far below the old one.
    const next = applyDeltas(second, [
      event(4, {
        kind: "reservation.acquired",
        beadId: "b-1",
        payload: { worktree: "wt", globs: ["a/**"] },
      }),
    ]);
    expect(next.cursor).toBe(4);
    expect(next.reservations.data).toHaveLength(1);
  });
});

describe("state: deltas", () => {
  const acquire = (id: number, bead = "b-1", worktree = "wt") =>
    event(id, {
      kind: "reservation.acquired",
      beadId: bead,
      sessionId: "s-1",
      payload: { worktree, globs: ["docs/**"] },
    });
  const release = (id: number, bead = "b-1", worktree = "wt") =>
    event(id, {
      kind: "reservation.released",
      beadId: bead,
      payload: { worktree, globs: ["docs/**"] },
    });

  test("a delta at or below the cursor is ignored and the SAME object comes back", () => {
    const state = live({ cursor: 10 });
    expect(applyDeltas(state, [acquire(10), acquire(7)])).toBe(state);
    expect(applyDeltas(state, [])).toBe(state);
  });

  test("deltas before any snapshot are not applied", () => {
    expect(applyDeltas(INITIAL_LIVE_STATE, [acquire(1)])).toBe(
      INITIAL_LIVE_STATE,
    );
  });

  test("a batch is applied in id order whatever order it arrived in", () => {
    const state = applyDeltas(live({ cursor: 10 }), [
      release(13),
      acquire(11),
      acquire(12, "b-2"),
    ]);
    expect(state.cursor).toBe(13);
    // 11 acquired b-1, 12 acquired b-2, 13 released b-1. Out of order, the
    // release would have come first and b-1 would still be held.
    expect(state.reservations.data?.map((held) => held.beadId)).toEqual([
      "b-2",
    ]);
  });

  test("a replayed batch changes nothing the second time", () => {
    const batch = [acquire(11), acquire(12, "b-2")];
    const once = applyDeltas(live({ cursor: 10 }), batch);
    expect(applyDeltas(once, batch)).toBe(once);
    // A replay that overlaps: only the new id is applied.
    const more = applyDeltas(once, [...batch, release(13)]);
    expect(more.cursor).toBe(13);
    expect(more.reservations.data?.map((held) => held.beadId)).toEqual(["b-2"]);
  });

  test("an old id that arrives beside a new one is not applied a second time", () => {
    // b-1 was claimed (11) and given back (12). A resume replays 11 with 13.
    const settled = applyDeltas(live({ cursor: 10 }), [
      acquire(11),
      release(12),
    ]);
    expect(settled.reservations.data).toEqual([]);
    const next = applyDeltas(settled, [
      acquire(11),
      event(13, { kind: "gate.ran", payload: { gate: "tsc", passed: true } }),
    ]);
    expect(next.cursor).toBe(13);
    // Applied again, the old claim would be held once more.
    expect(next.reservations.data).toEqual([]);
  });

  test("the same id twice in one batch is applied once", () => {
    const state = applyDeltas(live({ cursor: 10 }), [
      acquire(11),
      acquire(11),
      release(12),
      acquire(13),
    ]);
    expect(state.reservations.data).toHaveLength(1);
    expect(state.cursor).toBe(13);
  });

  test("the cursor moves past kinds that fold into nothing", () => {
    const before = live({ cursor: 10 });
    const state = applyDeltas(before, [
      event(11, { kind: "gate.ran", payload: { gate: "tsc", passed: true } }),
    ]);
    expect(state).not.toBe(before);
    expect(state.cursor).toBe(11);
    expect(state.sessions).toBe(before.sessions);
    expect(state.reservations).toBe(before.reservations);
  });

  test("reservations fold as the route folds them", () => {
    const held: Reservation = {
      beadId: "b-0",
      worktree: "wt-0",
      workspace: WORKSPACE,
      globs: ["x"],
      acquiredAt: "2026-10-11T10:00:00.000Z",
    };
    const state = applyDeltas(live({ reservations: ok([held]) }), [
      acquire(11),
      // No bead: cannot form a reservation.
      event(12, {
        kind: "reservation.acquired",
        payload: { worktree: "wt", globs: [] },
      }),
      // The same bead in another worktree is another claim.
      acquire(13, "b-1", "wt-2"),
      // Taken again: sorts by its new time, after wt-2.
      acquire(14),
      release(15, "b-0", "wt-0"),
    ]);
    expect(
      state.reservations.data?.map((r) => `${r.beadId}@${r.worktree}`),
    ).toEqual(["b-1@wt-2", "b-1@wt"]);
    expect(state.reservations.data?.[1]).toEqual({
      beadId: "b-1",
      worktree: "wt",
      workspace: WORKSPACE,
      globs: ["docs/**"],
      sessionId: "s-1",
      acquiredAt: "2026-10-11T12:00:14.000Z",
    });
  });

  test("an unknown collection is not merged into", () => {
    const state = applyDeltas(live({ reservations: failed("ledger busy") }), [
      acquire(11),
    ]);
    expect(state.cursor).toBe(11);
    expect(state.reservations).toEqual({ data: null, error: "ledger busy" });
  });

  test("sessions fold as the route folds them", () => {
    const state = applyDeltas(
      live({ sessions: ok([session("old"), session("s-1")]) }),
      [
        event(11, {
          kind: "session.started",
          sessionId: "s-2",
          executor: { provider: "claude", model: "m-1", effort: "high" },
          payload: { kind: "headless", worktree: "wt-2", parentSessionId: "p" },
        }),
        event(12, {
          kind: "tool.called",
          sessionId: "s-1",
          beadId: "b-1",
          runId: "run-1",
          payload: { tool: "Read", argsHash: "h" },
        }),
        // No session: touches none.
        event(13, { kind: "gate.ran", payload: { gate: "g", passed: true } }),
      ],
    );
    expect(state.sessions.data?.map((s) => s.sessionId)).toEqual([
      "s-1",
      "s-2",
      "old",
    ]);
    expect(state.sessions.data?.[1]).toEqual({
      sessionId: "s-2",
      workspace: WORKSPACE,
      kind: "headless",
      worktree: "wt-2",
      parentSessionId: "p",
      startedAt: "2026-10-11T12:00:11.000Z",
      lastEventAt: "2026-10-11T12:00:11.000Z",
      executor: {
        provider: "claude",
        model: "m-1",
        effort: "high",
        sessionId: "s-2",
      },
    });
    expect(state.sessions.data?.[0]).toEqual({
      sessionId: "s-1",
      workspace: WORKSPACE,
      lastEventAt: "2026-10-11T12:00:12.000Z",
      beadId: "b-1",
      runId: "run-1",
    });
  });

  test("a session is ended only while its newest event says so", () => {
    const ended = applyDeltas(live({ sessions: ok([session("s-1")]) }), [
      event(11, { kind: "session.ended", sessionId: "s-1", payload: {} }),
    ]);
    expect(ended.sessions.data?.[0]?.endedAt).toBe("2026-10-11T12:00:11.000Z");
    expect(liveStats(ended)?.openSessions).toBe(0);

    const resumed = applyDeltas(ended, [
      event(12, {
        kind: "prompt.submitted",
        sessionId: "s-1",
        payload: { hash: "h", length: 1 },
      }),
    ]);
    expect(resumed.sessions.data?.[0]).not.toHaveProperty("endedAt");
    expect(liveStats(resumed)?.openSessions).toBe(1);
  });

  test("an executor without a model does not replace the known one", () => {
    const known = session("s-1", {
      executor: { provider: "claude", model: "m-1", sessionId: "s-1" },
    });
    const state = applyDeltas(live({ sessions: ok([known]) }), [
      // justification: an emitter that knew only the provider; the fold must not take it.
      event(11, {
        kind: "tool.called",
        sessionId: "s-1",
        executor: { provider: "codex", model: "" },
        payload: { tool: "Read", argsHash: "h" },
      }),
    ]);
    expect(state.sessions.data?.[0]?.executor).toEqual(known.executor);
  });

  test("the merged session list is capped, newest kept", () => {
    const many = Array.from({ length: MAX_LIVE_SESSIONS }, (_, index) =>
      session(`s-${index}`),
    );
    const state = applyDeltas(live({ sessions: ok(many) }), [
      event(11, {
        kind: "prompt.submitted",
        sessionId: "new",
        payload: { hash: "h", length: 1 },
      }),
    ]);
    expect(state.sessions.data).toHaveLength(MAX_LIVE_SESSIONS);
    expect(state.sessions.data?.[0]?.sessionId).toBe("new");
    expect(state.sessions.data?.at(-1)?.sessionId).toBe(
      `s-${MAX_LIVE_SESSIONS - 2}`,
    );
  });
});

describe("state: status, refetched collections and the stat cards", () => {
  test("a status that does not change returns the same object", () => {
    const state = live();
    expect(withStatus(state, "live")).toBe(state);
    const off = withStatus(state, "off", "no-hearth");
    expect(off).toMatchObject({ status: "off", offReason: "no-hearth" });
    expect(withStatus(off, "off", "no-hearth")).toBe(off);
    // The reason belongs to "off" only.
    expect(withStatus(off, "reconnecting").offReason).toBeNull();
  });

  test("a refetched collection replaces the old one and leaves the cursor", () => {
    const state = live({ cursor: 10 });
    const next = withCollection(state, "runs", ok([run("alpha")]));
    expect(next.cursor).toBe(10);
    expect(next.runs.data).toHaveLength(1);
    expect(withCollection(next, "queue", failed("bd failed")).queue).toEqual({
      data: null,
      error: "bd failed",
    });
  });

  test("the stat cards count what the routes would", () => {
    const runs = [
      run("in-flight"),
      run("shipped", { complete: true, next: null }),
      run("halted", {
        complete: true,
        halted: { phase: "ship", reason: "budget" },
      }),
      run("awaiting-review", { complete: true, reviewPending: "ship" }),
    ];
    const state = live({
      runs: ok(runs),
      sessions: ok([
        session("open"),
        session("ended", { endedAt: "2026-10-11T11:30:00.000Z" }),
      ]),
      queue: ok([
        { beadId: "a", title: "A", state: "queued", status: "open" },
        { beadId: "b", title: "B", state: "running", status: "in_progress" },
        { beadId: "c", title: "C", state: "done", status: "closed" },
      ]),
      reservations: ok([
        {
          beadId: "a",
          worktree: "wt",
          workspace: WORKSPACE,
          globs: [],
          acquiredAt: "2026-10-11T10:00:00.000Z",
        },
      ]),
    });
    expect(liveStats(state)).toEqual({
      // The same rule as the runs CLI and the Forge run page.
      runsInFlight: activeRuns(runs).length,
      openSessions: 1,
      queued: 2,
      claims: 1,
    });
    expect(activeRuns(runs)).toHaveLength(3);
  });

  test("the stat cards go away when live updates are off", () => {
    expect(liveStats(withStatus(live(), "off", "lost"))).toBeNull();
    // A reconnect keeps showing the last known numbers.
    expect(liveStats(withStatus(live(), "reconnecting"))).not.toBeNull();
  });
});

// ── Stand-ins ───────────────────────────────────────────────────────────────

/** Timers a test moves by hand. Nothing here touches the real clock. */
function standInClock() {
  let now = 0;
  let next = 0;
  const pending = new Map<number, { at: number; run: () => void }>();
  const timers: Timers = {
    set(run, ms) {
      next += 1;
      pending.set(next, { at: now + ms, run });
      return next;
    },
    clear(handle) {
      pending.delete(Number(handle));
    },
  };
  return {
    timers,
    now: () => now,
    /** How long each pending timer still has, soonest first. */
    waits: () =>
      [...pending.values()].map((t) => t.at - now).sort((a, b) => a - b),
    /** Move time on, running every timer that comes due, in order. */
    advance(ms: number) {
      const until = now + ms;
      for (;;) {
        const due = [...pending.entries()]
          .filter(([, timer]) => timer.at <= until)
          .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (due === undefined) break;
        now = due[1].at;
        pending.delete(due[0]);
        due[1].run();
      }
      now = until;
    },
  };
}

interface StandInConnection {
  lastEventId: number | null;
  handlers: StreamHandlers;
  closed: boolean;
  open(): void;
  snapshot(over?: Partial<StreamSnapshot>): void;
  delta(...events: LedgerEvent[]): void;
  keepalive(): void;
  end(outcome: StreamEnd): void;
}

/** A transport that records every connection asked for and lets the test speak as the server. */
function standInTransport() {
  const connections: StandInConnection[] = [];
  const transport: StreamTransport = (lastEventId, handlers) => {
    const connection: StandInConnection = {
      lastEventId,
      handlers,
      closed: false,
      open: () => handlers.onOpen(),
      snapshot(over = {}) {
        const data = snapshot(over);
        handlers.onMessage({
          event: "snapshot",
          id: String(data.cursor),
          data: JSON.stringify(data),
        });
      },
      delta(...events) {
        for (const one of events)
          handlers.onMessage({
            event: "delta",
            id: String(one.id),
            data: JSON.stringify(one),
          });
      },
      keepalive: () => handlers.onActivity(),
      end: (outcome) => handlers.onEnd(outcome),
    };
    connections.push(connection);
    return {
      close() {
        connection.closed = true;
      },
    };
  };
  return {
    transport,
    connections,
    /** The newest connection; fails the test when none was asked for. */
    get current(): StandInConnection {
      const newest = connections.at(-1);
      if (newest === undefined) throw new Error("no connection was opened");
      return newest;
    },
  };
}

/** Let promise callbacks already queued run. */
const settle = (): Promise<void> => new Promise((done) => setImmediate(done));

/** A read route stand-in: records the paths asked for; each read waits until the test answers it. */
function standInRead() {
  const asked: string[] = [];
  const waitingReads: Array<{
    path: string;
    answer(envelope: OperatorEnvelope<unknown>): void;
    fail(): void;
  }> = [];
  return {
    asked,
    waitingReads,
    read(path: string): Promise<OperatorEnvelope<unknown>> {
      asked.push(path);
      return new Promise((answer, reject) => {
        waitingReads.push({
          path,
          answer,
          fail: () => reject(new Error("unreachable")),
        });
      });
    },
    /** Answer the oldest unanswered read. */
    async answer(envelope: OperatorEnvelope<unknown>) {
      waitingReads.shift()?.answer(envelope);
      await settle();
    },
  };
}

function harness(random: () => number = () => 0.5) {
  const clock = standInClock();
  const wire = standInTransport();
  const reads = standInRead();
  const client = createStreamClient({
    transport: wire.transport,
    read: (path) => reads.read(path),
    timers: clock.timers,
    now: clock.now,
    random,
  });
  return { clock, wire, reads, client };
}

const gate = (id: number): LedgerEvent =>
  event(id, { kind: "gate.ran", payload: { gate: "tsc", passed: true } });
const phaseDone = (id: number, slug = "alpha"): LedgerEvent =>
  event(id, {
    kind: "run.phase.completed",
    runId: slug,
    payload: { phase: "research" },
  });

// ── The parser ──────────────────────────────────────────────────────────────

describe("reading server-sent events", () => {
  function parse(chunks: string[], maxBuffer?: number) {
    const messages: SseMessage[] = [];
    const parser = createSseParser((m) => messages.push(m), maxBuffer);
    const accepted = chunks.map((chunk) => parser.push(chunk));
    return { messages, accepted };
  }

  test("a message is read as the hearth writes it", () => {
    const { messages } = parse(['event: delta\nid: 7\ndata: {"a":1}\n\n']);
    expect(messages).toEqual([{ event: "delta", id: "7", data: '{"a":1}' }]);
  });

  test("a message split across chunks, even inside its blank line, is one message", () => {
    const { messages } = parse([
      "event: snap",
      'shot\nid: 1\ndata: {"cur',
      'sor":1}\n',
      "\nevent: delta\nid: 2\ndata: {}\n\n",
    ]);
    expect(messages.map((m) => [m.event, m.id, m.data])).toEqual([
      ["snapshot", "1", '{"cursor":1}'],
      ["delta", "2", "{}"],
    ]);
  });

  test("a keepalive comment is not a message", () => {
    const { messages } = parse([
      ": keepalive\n\n",
      "event: delta\nid: 3\ndata: 1\n\n",
    ]);
    expect(messages).toEqual([{ event: "delta", id: "3", data: "1" }]);
  });

  test("a message that never ends is refused once it outgrows the limit", () => {
    const { accepted, messages } = parse(["data: 123", "45", "x"], 11);
    expect(accepted).toEqual([true, true, false]);
    expect(messages).toEqual([]);
  });

  test("what was read is not kept: the limit is on the unfinished part only", () => {
    const one = "data: 1234\n\n";
    expect(parse([one, one, one, one], 12).accepted).toEqual([
      true,
      true,
      true,
      true,
    ]);
  });
});

// ── The client on a stand-in transport ──────────────────────────────────────

describe("client: one connection", () => {
  test("nothing is asked for until someone subscribes; many subscribers share one connection; the last one closes it", () => {
    const { wire, client } = harness();
    expect(wire.connections).toHaveLength(0);

    const first = client.subscribe(() => undefined);
    const second = client.subscribe(() => undefined);
    const third = client.watch(["gate.ran"], () => undefined);
    expect(wire.connections).toHaveLength(1);
    expect(wire.current.lastEventId).toBeNull();

    first();
    third();
    expect(wire.current.closed).toBe(false);
    second();
    expect(wire.current.closed).toBe(true);
    expect(wire.connections).toHaveLength(1);
  });

  test("an unsubscribe called twice releases once", () => {
    const { wire, client } = harness();
    const first = client.subscribe(() => undefined);
    client.subscribe(() => undefined);
    first();
    first();
    expect(wire.current.closed).toBe(false);
  });

  test("a subscriber that comes back resumes from the last id applied", () => {
    const { wire, client } = harness();
    const leave = client.subscribe(() => undefined);
    wire.current.open();
    wire.current.snapshot({ cursor: 30 });
    leave();

    client.subscribe(() => undefined);
    expect(wire.connections).toHaveLength(2);
    expect(wire.current.lastEventId).toBe(30);
  });

  test("a call from a connection that was closed is ignored", () => {
    const { wire, client, clock } = harness();
    const leave = client.subscribe(() => undefined);
    const old = wire.current;
    old.open();
    old.snapshot({ cursor: 5 });
    leave();
    client.subscribe(() => undefined);

    old.delta(gate(6));
    old.end("refused");
    clock.advance(BATCH_MS);
    expect(client.getState().cursor).toBe(5);
    expect(client.getState().status).not.toBe("off");
  });
});

describe("client: snapshot and deltas", () => {
  test("a snapshot is applied at once and the subscriber is told once", () => {
    const { wire, client } = harness();
    let told = 0;
    client.subscribe(() => {
      told += 1;
    });
    expect(client.getState().status).toBe("connecting");
    wire.current.open();
    // An open stream with nothing read yet is not live: there is nothing to show.
    expect(client.getState().status).toBe("connecting");
    expect(told).toBe(0);

    wire.current.snapshot({ cursor: 12, runs: ok([run("alpha")]) });
    expect(told).toBe(1);
    expect(client.getState()).toMatchObject({ status: "live", cursor: 12 });
    expect(client.getState().runs.data).toHaveLength(1);
  });

  test("deltas wait for the batch window and become one update", () => {
    const { wire, client, clock } = harness();
    let told = 0;
    client.subscribe(() => {
      told += 1;
    });
    wire.current.open();
    wire.current.snapshot({ cursor: 10 });
    told = 0;

    wire.current.delta(gate(11), gate(12));
    clock.advance(BATCH_MS - 1);
    wire.current.delta(gate(13));
    expect(told).toBe(0);
    expect(client.getState().cursor).toBe(10);

    clock.advance(1);
    expect(told).toBe(1);
    expect(client.getState().cursor).toBe(13);
    // Nothing is left to apply: more time changes nothing.
    clock.advance(BATCH_MS * 4);
    expect(told).toBe(1);
  });

  test("a full batch is applied without waiting", () => {
    const { wire, client } = harness();
    let told = 0;
    client.subscribe(() => {
      told += 1;
    });
    wire.current.open();
    wire.current.snapshot({ cursor: 0 });
    told = 0;

    for (let id = 1; id < BATCH_MAX; id++) wire.current.delta(gate(id));
    expect(told).toBe(0);
    wire.current.delta(gate(BATCH_MAX));
    expect(told).toBe(1);
    expect(client.getState().cursor).toBe(BATCH_MAX);
  });

  test("deltas that arrive out of order are applied in ledger order", () => {
    const { wire, client, clock } = harness();
    client.subscribe(() => undefined);
    wire.current.open();
    wire.current.snapshot({ cursor: 10 });
    const claim = (
      id: number,
      kind: "reservation.acquired" | "reservation.released",
    ) =>
      event(id, {
        kind,
        beadId: "b-1",
        payload: { worktree: "wt", globs: [] },
      });

    wire.current.delta(
      claim(12, "reservation.released"),
      claim(11, "reservation.acquired"),
    );
    clock.advance(BATCH_MS);
    expect(client.getState().cursor).toBe(12);
    expect(client.getState().reservations.data).toEqual([]);
  });

  test("an id the snapshot already covers, and a replayed id, tell nobody", () => {
    const { wire, client, clock } = harness();
    let told = 0;
    const kinds: WatchReason[] = [];
    client.subscribe(() => {
      told += 1;
    });
    client.watch(["gate.ran"], (reason) => kinds.push(reason));
    wire.current.open();
    wire.current.snapshot({ cursor: 10 });
    told = 0;

    wire.current.delta(gate(9), gate(10));
    clock.advance(BATCH_MS);
    expect(told).toBe(0);
    expect(kinds).toEqual([]);

    wire.current.delta(gate(11));
    clock.advance(BATCH_MS);
    wire.current.delta(gate(11));
    clock.advance(BATCH_MS);
    expect(told).toBe(1);
    expect(kinds).toEqual(["events"]);
    expect(client.getState().cursor).toBe(11);
  });

  test("a message that is not what the hearth sends is ignored and the stream goes on", () => {
    const { wire, client, clock } = harness();
    client.subscribe(() => undefined);
    wire.current.open();
    wire.current.snapshot({ cursor: 10 });

    const send = (name: string, data: string) =>
      wire.current.handlers.onMessage({ event: name, id: "11", data });
    send("delta", "not json");
    send("delta", JSON.stringify({ id: "eleven", kind: "gate.ran" }));
    send("snapshot", JSON.stringify({ cursor: 99 }));
    send("something-else", JSON.stringify(gate(11)));
    clock.advance(BATCH_MS);
    expect(client.getState()).toMatchObject({ status: "live", cursor: 10 });

    wire.current.delta(gate(11));
    clock.advance(BATCH_MS);
    expect(client.getState().cursor).toBe(11);
    expect(wire.connections).toHaveLength(1);
  });
});

describe("client: reconnect", () => {
  test("a stream that ends is asked for again, resuming after the last id RECEIVED", () => {
    const { wire, client, clock } = harness(() => 0);
    client.subscribe(() => undefined);
    wire.current.open();
    wire.current.snapshot({ cursor: 10 });
    wire.current.delta(gate(11), gate(12));
    // The batch window has not passed: 11 and 12 are received, not yet applied.
    wire.current.end("ended");

    expect(client.getState()).toMatchObject({
      status: "reconnecting",
      cursor: 12,
    });
    expect(wire.connections).toHaveLength(1);
    clock.advance(249);
    expect(wire.connections).toHaveLength(1);
    clock.advance(1);
    expect(wire.connections).toHaveLength(2);
    expect(wire.current.lastEventId).toBe(12);

    // A resume has no snapshot: the page is live again on what it has.
    wire.current.open();
    expect(client.getState()).toMatchObject({ status: "live", cursor: 12 });
    wire.current.delta(gate(13));
    clock.advance(BATCH_MS);
    expect(client.getState().cursor).toBe(13);
  });

  test("a failure before any snapshot retries without an id", () => {
    const { wire, client, clock } = harness(() => 0);
    client.subscribe(() => undefined);
    wire.current.end("failed");
    expect(client.getState().status).toBe("reconnecting");
    clock.advance(250);
    expect(wire.connections).toHaveLength(2);
    expect(wire.current.lastEventId).toBeNull();
  });

  test("each wait is a random part, from half to all, of a ceiling that doubles", () => {
    for (const [random, factor] of [
      [() => 0, 0.5],
      [() => 0.5, 0.75],
      [() => 0.999999, 0.9999995],
    ] as const) {
      const { wire, client, clock } = harness(random);
      client.subscribe(() => undefined);
      const waits: number[] = [];
      for (let attempt = 1; attempt < MAX_FAILURES; attempt++) {
        wire.current.end("failed");
        const [wait] = clock.waits();
        waits.push(wait ?? -1);
        clock.advance(wait ?? 0);
      }
      const ceilings = [500, 1000, 2000, 4000, 8000];
      expect(waits).toHaveLength(ceilings.length);
      waits.forEach((wait, index) => {
        expect(wait).toBeCloseTo((ceilings[index] ?? 0) * factor, 3);
      });
    }
  });

  test("six failures in a row turn live updates off, and nothing asks again", () => {
    const { wire, client, clock } = harness();
    client.subscribe(() => undefined);
    for (let attempt = 1; attempt <= MAX_FAILURES; attempt++) {
      expect(client.getState().status).not.toBe("off");
      wire.current.end("failed");
      clock.advance(60_000);
    }
    expect(wire.connections).toHaveLength(MAX_FAILURES);
    expect(client.getState()).toMatchObject({
      status: "off",
      offReason: "lost",
    });

    clock.advance(600_000);
    client.subscribe(() => undefined);
    client.watch(["gate.ran"], () => undefined);
    expect(wire.connections).toHaveLength(MAX_FAILURES);
    expect(clock.waits()).toEqual([]);
  });

  test("a stream that delivers bytes starts the count again", () => {
    const { wire, client, clock } = harness(() => 0);
    client.subscribe(() => undefined);
    for (let attempt = 1; attempt < MAX_FAILURES; attempt++) {
      wire.current.end("failed");
      clock.advance(60_000);
    }
    // One more failure would turn it off. A stream opens and a keepalive arrives.
    wire.current.open();
    wire.current.keepalive();
    wire.current.end("ended");
    expect(client.getState().status).toBe("reconnecting");
    expect(clock.waits()).toEqual([250]);
  });

  test("a quiet resumed stream that stays open resets the count before any byte arrives", () => {
    const { wire, client, clock } = harness(() => 0);
    client.subscribe(() => undefined);
    for (let attempt = 1; attempt < MAX_FAILURES; attempt++) {
      wire.current.end("failed");
      clock.advance(60_000);
    }
    // One more failure would turn it off. A stream opens and says nothing yet.
    wire.current.open();
    clock.advance(STABLE_MS - 1);
    expect(clock.waits()).toContain(1);
    clock.advance(1);
    wire.current.end("ended");
    expect(client.getState().status).toBe("reconnecting");
    // Back to the shortest wait: the count started again.
    expect(clock.waits()).toEqual([250]);
  });

  test("a stream that ends before it has stayed open long enough does not reset the count", () => {
    const { wire, client, clock } = harness(() => 0);
    client.subscribe(() => undefined);
    for (let attempt = 1; attempt < MAX_FAILURES; attempt++) {
      wire.current.end("failed");
      clock.advance(60_000);
    }
    wire.current.open();
    clock.advance(STABLE_MS - 1);
    wire.current.end("ended");
    expect(client.getState()).toMatchObject({
      status: "off",
      offReason: "lost",
    });
    // The cancelled timer never fires.
    expect(clock.waits()).toEqual([]);
  });

  test("a stream that only opens and ends, over and over, still runs out", () => {
    const { wire, client, clock } = harness();
    client.subscribe(() => undefined);
    for (let attempt = 1; attempt <= MAX_FAILURES; attempt++) {
      wire.current.open();
      wire.current.end("ended");
      clock.advance(60_000);
    }
    expect(client.getState()).toMatchObject({
      status: "off",
      offReason: "lost",
    });
    expect(wire.connections).toHaveLength(MAX_FAILURES);
  });

  test("a connection that says nothing for three keepalives is given up and asked for again", () => {
    const { wire, client, clock } = harness(() => 0);
    client.subscribe(() => undefined);
    wire.current.open();
    wire.current.snapshot({ cursor: 10 });

    clock.advance(SILENCE_MS - 1);
    wire.current.keepalive();
    clock.advance(SILENCE_MS - 1);
    expect(wire.current.closed).toBe(false);
    expect(client.getState().status).toBe("live");

    clock.advance(1);
    expect(wire.connections[0]?.closed).toBe(true);
    expect(client.getState().status).toBe("reconnecting");
    clock.advance(250);
    expect(wire.connections).toHaveLength(2);
    expect(wire.current.lastEventId).toBe(10);
  });

  test("leaving while a retry is waiting cancels it", () => {
    const { wire, client, clock } = harness();
    const leave = client.subscribe(() => undefined);
    wire.current.end("failed");
    leave();
    expect(clock.waits()).toEqual([]);
    clock.advance(60_000);
    expect(wire.connections).toHaveLength(1);
  });

  test("a transport that fails before it returns is retried like any other", () => {
    const clock = standInClock();
    let asked = 0;
    const client = createStreamClient({
      transport: (_id, handlers) => {
        asked += 1;
        handlers.onEnd("failed");
        return { close: () => undefined };
      },
      read: () => Promise.reject(new Error("unused")),
      timers: clock.timers,
      now: clock.now,
      random: () => 0,
    });
    client.subscribe(() => undefined);
    expect(asked).toBe(1);
    clock.advance(250);
    expect(asked).toBe(2);
  });
});

describe("client: static fallback", () => {
  test("an answer that is not a stream turns live updates off after ONE request, for good", () => {
    const { wire, client, clock } = harness();
    let told = 0;
    const leave = client.subscribe(() => {
      told += 1;
    });
    wire.current.end("refused");

    expect(client.getState()).toMatchObject({
      status: "off",
      offReason: "no-hearth",
      cursor: null,
    });
    expect(told).toBe(1);
    expect(liveStats(client.getState())).toBeNull();
    // No retry is waiting, and none ever starts.
    expect(clock.waits()).toEqual([]);
    clock.advance(3_600_000);
    leave();
    client.subscribe(() => undefined);
    client.watch(["run.phase.completed"], () => undefined);
    clock.advance(3_600_000);
    expect(wire.connections).toHaveLength(1);
    expect(client.getState().status).toBe("off");
  });

  test("a refusal after the page was live keeps what it had and stops asking", () => {
    const { wire, client, clock, reads } = harness(() => 0);
    client.subscribe(() => undefined);
    wire.current.open();
    wire.current.snapshot({ cursor: 10, runs: ok([run("alpha")]) });
    wire.current.end("ended");
    clock.advance(250);
    wire.current.end("refused");

    expect(client.getState()).toMatchObject({
      status: "off",
      offReason: "no-hearth",
    });
    expect(client.getState().runs.data).toHaveLength(1);
    clock.advance(3_600_000);
    expect(wire.connections).toHaveLength(2);
    expect(reads.asked).toEqual([]);
  });
});

describe("client: watchers and the routes read again", () => {
  test("a watcher is told once per batch that held one of its kinds, and not otherwise", () => {
    const { wire, client, clock } = harness();
    const gates: WatchReason[] = [];
    const phases: WatchReason[] = [];
    client.watch(["gate.ran", "verdict.bound"], (reason) => gates.push(reason));
    const stop = client.watch(["run.phase.completed"], (reason) =>
      phases.push(reason),
    );
    wire.current.open();
    wire.current.snapshot({ cursor: 10 });
    // The first open is not a resync: every view has just read its own data.
    expect(gates).toEqual([]);

    wire.current.delta(gate(11), gate(12), gate(13));
    clock.advance(BATCH_MS);
    expect(gates).toEqual(["events"]);
    expect(phases).toEqual([]);

    wire.current.delta(phaseDone(14));
    clock.advance(BATCH_MS);
    expect(phases).toEqual(["events"]);
    expect(gates).toEqual(["events"]);

    stop();
    wire.current.delta(phaseDone(15));
    clock.advance(BATCH_MS);
    expect(phases).toEqual(["events"]);
  });

  test("every watcher is told once when the stream reopens", () => {
    const { wire, client, clock } = harness(() => 0);
    const told: WatchReason[] = [];
    client.watch(["gate.ran"], (reason) => told.push(reason));
    wire.current.open();
    wire.current.snapshot({ cursor: 10 });
    wire.current.end("ended");
    clock.advance(250);
    expect(told).toEqual([]);
    wire.current.open();
    expect(told).toEqual(["resync"]);
  });

  test("a completed phase reads the runs route again, and only that route", async () => {
    const { wire, client, clock, reads } = harness();
    client.subscribe(() => undefined);
    wire.current.open();
    wire.current.snapshot({ cursor: 10 });
    expect(reads.asked).toEqual([]);

    wire.current.delta(gate(11));
    clock.advance(BATCH_MS);
    expect(reads.asked).toEqual([]);

    wire.current.delta(phaseDone(12));
    clock.advance(BATCH_MS);
    expect(reads.asked).toEqual(["/runs"]);
    await reads.answer(ok([run("alpha"), run("beta")]));
    expect(client.getState().runs.data).toHaveLength(2);
    expect(liveStats(client.getState())?.runsInFlight).toBe(2);
    expect(client.getState().cursor).toBe(12);
  });

  test("a tracker write reads the queue route again", async () => {
    const { wire, client, clock, reads } = harness();
    client.subscribe(() => undefined);
    wire.current.open();
    wire.current.snapshot({ cursor: 10 });
    wire.current.delta(
      event(11, {
        kind: "bead.transitioned",
        beadId: "b-1",
        payload: { action: "close" },
      }),
    );
    clock.advance(BATCH_MS);
    expect(reads.asked).toEqual(["/queue"]);
    await reads.answer(failed("bd is not installed"));
    expect(client.getState().queue).toEqual({
      data: null,
      error: "bd is not installed",
    });
  });

  test("a burst of events is one read now and one after it; nothing reads on a timer", async () => {
    const { wire, client, clock, reads } = harness();
    client.subscribe(() => undefined);
    wire.current.open();
    wire.current.snapshot({ cursor: 0 });

    // Ten batches, each with a completed phase, while the first read is unanswered.
    for (let id = 1; id <= 10; id++) {
      wire.current.delta(phaseDone(id));
      clock.advance(BATCH_MS);
    }
    expect(reads.asked).toEqual(["/runs"]);

    // The first read answers 500 ms after it started: past the window, so the one trailing read starts at once.
    await reads.answer(ok([run("alpha")]));
    expect(reads.asked).toEqual(["/runs", "/runs"]);
    await reads.answer(ok([run("alpha")]));

    // Quiet from here on: an hour passes and nothing is read.
    clock.advance(3_600_000);
    await settle();
    expect(reads.asked).toHaveLength(2);
  });

  test("a read that fails keeps what was shown", async () => {
    const { wire, client, clock, reads } = harness();
    client.subscribe(() => undefined);
    wire.current.open();
    wire.current.snapshot({ cursor: 10, runs: ok([run("alpha")]) });
    wire.current.delta(phaseDone(11));
    clock.advance(BATCH_MS);
    reads.waitingReads.shift()?.fail();
    await settle();
    expect(client.getState().runs.data).toHaveLength(1);
  });

  test("the stream reopening reads both routes again", () => {
    const { wire, client, clock, reads } = harness(() => 0);
    client.subscribe(() => undefined);
    wire.current.open();
    wire.current.snapshot({ cursor: 10 });
    wire.current.end("ended");
    clock.advance(250);
    wire.current.open();
    expect([...reads.asked].sort()).toEqual(["/queue", "/runs"]);
  });
});

// ── Reading a route again ───────────────────────────────────────────────────

describe("refetcher", () => {
  function setup() {
    const clock = standInClock();
    const finish: Array<() => void> = [];
    const refetcher = createRefetcher({
      timers: clock.timers,
      now: clock.now,
      run: () => new Promise<void>((done) => finish.push(done)),
    });
    const done = async () => {
      finish.shift()?.();
      await settle();
    };
    return { clock, refetcher, started: () => finish.length, done };
  }

  test("the first ask reads at once", () => {
    const { refetcher, started } = setup();
    refetcher.request();
    expect(started()).toBe(1);
  });

  test("asks while a read is in flight become exactly one read after it", async () => {
    const { refetcher, clock, started, done } = setup();
    refetcher.request();
    refetcher.request();
    refetcher.request();
    refetcher.request();
    expect(started()).toBe(1);

    clock.advance(REFETCH_WINDOW_MS);
    await done();
    // The three asks made meanwhile started one read, and no third follows it.
    expect(started()).toBe(1);
    await done();
    clock.advance(REFETCH_WINDOW_MS * 10);
    await settle();
    expect(started()).toBe(0);
  });

  test("a second read does not start inside the window of the first", async () => {
    const { refetcher, clock, started, done } = setup();
    refetcher.request();
    await done();
    expect(started()).toBe(0);

    clock.advance(REFETCH_WINDOW_MS - 100);
    refetcher.request();
    refetcher.request();
    expect(started()).toBe(0);
    clock.advance(99);
    expect(started()).toBe(0);
    clock.advance(1);
    expect(started()).toBe(1);
  });

  test("past the window an ask reads at once again", async () => {
    const { refetcher, clock, started, done } = setup();
    refetcher.request();
    await done();
    clock.advance(REFETCH_WINDOW_MS);
    refetcher.request();
    expect(started()).toBe(1);
  });

  test("a read that rejects does not stop the next one", async () => {
    const clock = standInClock();
    let starts = 0;
    const refetcher = createRefetcher({
      timers: clock.timers,
      now: clock.now,
      run: () => {
        starts += 1;
        return Promise.reject(new Error("away"));
      },
    });
    refetcher.request();
    await settle();
    clock.advance(REFETCH_WINDOW_MS);
    refetcher.request();
    expect(starts).toBe(2);
  });

  test("disposed, it starts nothing more", async () => {
    const { refetcher, clock, started, done } = setup();
    refetcher.request();
    await done();
    refetcher.request();
    refetcher.dispose();
    clock.advance(REFETCH_WINDOW_MS * 2);
    refetcher.request();
    expect(started()).toBe(0);
  });
});

describe("a view that reads its own route", () => {
  function view(loads: Array<() => Promise<string>>) {
    const { wire, client, clock } = harness();
    let state: DevApiState<string> = { data: null, error: null, loading: true };
    let asked = 0;
    const stop = startLiveRead<string>({
      client,
      kinds: ["run.phase.completed"],
      timers: clock.timers,
      now: clock.now,
      load: () => {
        const next = loads[asked];
        asked += 1;
        return next ? next() : Promise.reject(new Error("no more answers"));
      },
      onChange: (update) => {
        state = update(state);
      },
    });
    wire.current.open();
    wire.current.snapshot({ cursor: 10 });
    return {
      wire,
      clock,
      stop,
      asked: () => asked,
      state: () => state,
      /** A completed phase arrives, the window having passed. */
      async phase(id: number) {
        clock.advance(REFETCH_WINDOW_MS);
        wire.current.delta(phaseDone(id));
        clock.advance(BATCH_MS);
        await settle();
      },
    };
  }

  test("it reads once on its own, and holds the connection while it is shown", async () => {
    const shown = view([async () => "first"]);
    await settle();
    expect(shown.state()).toEqual({
      data: "first",
      error: null,
      loading: false,
    });
    expect(shown.asked()).toBe(1);
    expect(shown.wire.current.closed).toBe(false);
    shown.stop();
    expect(shown.wire.current.closed).toBe(true);
  });

  test("an event of its kind reads again; another kind does not", async () => {
    const shown = view([async () => "first", async () => "second"]);
    await settle();
    shown.clock.advance(REFETCH_WINDOW_MS);
    shown.wire.current.delta(gate(11));
    shown.clock.advance(BATCH_MS);
    await settle();
    expect(shown.asked()).toBe(1);

    await shown.phase(12);
    expect(shown.asked()).toBe(2);
    expect(shown.state().data).toBe("second");
  });

  test("a later read that fails keeps the data on screen", async () => {
    const shown = view([
      async () => "first",
      () => Promise.reject(new Error("hearth away")),
    ]);
    await settle();
    await shown.phase(11);
    expect(shown.asked()).toBe(2);
    expect(shown.state()).toEqual({
      data: "first",
      error: null,
      loading: false,
    });
  });

  test("a first read that fails shows the error, and a later one that works replaces it", async () => {
    const shown = view([
      () => Promise.reject(new Error("HTTP 404")),
      async () => "second",
    ]);
    await settle();
    expect(shown.state()).toEqual({
      data: null,
      error: "HTTP 404",
      loading: false,
    });
    await shown.phase(11);
    expect(shown.state()).toEqual({
      data: "second",
      error: null,
      loading: false,
    });
  });

  test("stopped, it reads no more and changes nothing", async () => {
    const shown = view([async () => "first", async () => "second"]);
    await settle();
    shown.stop();
    await shown.phase(11);
    expect(shown.asked()).toBe(1);
    expect(shown.state().data).toBe("first");
  });
});

// ── The real transport ──────────────────────────────────────────────────────

/** A `fetch` stand-in that answers with what the test gives it and records the request. */
function standInFetch(answer: () => Response | Promise<Response>) {
  const requests: Array<{ url: string; headers: Record<string, string> }> = [];
  const fetchImpl = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    requests.push({
      url: String(input),
      headers: Object.fromEntries(
        Object.entries((init?.headers ?? {}) as Record<string, string>).map(
          ([name, value]) => [name.toLowerCase(), value],
        ),
      ),
    });
    return answer();
    // justification: only the call signature the transport uses is implemented.
  }) as typeof fetch;
  return { requests, fetchImpl };
}

/** Run one connection to its end and say what the handlers saw. */
function connectOnce(
  fetchImpl: typeof fetch,
  lastEventId: number | null = null,
): Promise<{ opened: boolean; messages: SseMessage[]; outcome: StreamEnd }> {
  return new Promise((done) => {
    let opened = false;
    const messages: SseMessage[] = [];
    fetchTransport("/__agent-forge/stream", { fetch: fetchImpl })(lastEventId, {
      onOpen: () => {
        opened = true;
      },
      onActivity: () => undefined,
      onMessage: (message) => messages.push(message),
      onEnd: (outcome) => done({ opened, messages, outcome }),
    });
  });
}

const streamOf = (text: string, status = 200): Response =>
  new Response(text, {
    status,
    headers: { "Content-Type": "text/event-stream" },
  });

describe("transport: fetch", () => {
  test("it asks for an event stream, sends no operator token, and no resume id on a first request", async () => {
    const { requests, fetchImpl } = standInFetch(() => streamOf(""));
    await connectOnce(fetchImpl);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("/__agent-forge/stream");
    expect(requests[0]?.headers).toEqual({ accept: "text/event-stream" });
    expect(requests[0]?.headers).not.toHaveProperty(OPERATOR_HEADER);
  });

  test("a resume sends the id as the Last-Event-ID header", async () => {
    const { requests, fetchImpl } = standInFetch(() => streamOf(""));
    await connectOnce(fetchImpl, 4711);
    expect(requests[0]?.headers["last-event-id"]).toBe("4711");
  });

  test("a stream is opened, read message by message, and reported ended when it closes", async () => {
    const { fetchImpl } = standInFetch(() =>
      streamOf('event: snapshot\nid: 3\ndata: {"cursor":3}\n\n: keepalive\n\n'),
    );
    const seen = await connectOnce(fetchImpl);
    expect(seen.opened).toBe(true);
    expect(seen.messages).toEqual([
      { event: "snapshot", id: "3", data: '{"cursor":3}' },
    ]);
    expect(seen.outcome).toBe("ended");
  });

  test("what a static host answers is a refusal: 404, or a page served for every path", async () => {
    const notFound = standInFetch(
      () => new Response("Not found", { status: 404 }),
    );
    expect(await connectOnce(notFound.fetchImpl)).toMatchObject({
      opened: false,
      outcome: "refused",
    });
    const page = standInFetch(
      () =>
        new Response("<!doctype html>", {
          status: 200,
          headers: { "Content-Type": "text/html" },
        }),
    );
    expect((await connectOnce(page.fetchImpl)).outcome).toBe("refused");
    const forbidden = standInFetch(() =>
      Response.json({ ok: false }, { status: 403 }),
    );
    expect((await connectOnce(forbidden.fetchImpl)).outcome).toBe("refused");
  });

  test("a server failure and no answer at all are failures, to be retried", async () => {
    const busy = standInFetch(() =>
      Response.json({ ok: false }, { status: 503 }),
    );
    expect((await connectOnce(busy.fetchImpl)).outcome).toBe("failed");
    const proxy = standInFetch(() => new Response("", { status: 502 }));
    expect((await connectOnce(proxy.fetchImpl)).outcome).toBe("failed");
    const down = standInFetch(() =>
      Promise.reject(new TypeError("fetch failed")),
    );
    expect(await connectOnce(down.fetchImpl)).toMatchObject({
      opened: false,
      outcome: "failed",
    });
  });

  test("closed by the client, it reports nothing more", async () => {
    let cancel: (() => void) | undefined;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(": keepalive\n\n"));
        cancel = () => controller.close();
      },
    });
    const { fetchImpl } = standInFetch(
      () =>
        new Response(body, {
          headers: { "Content-Type": "text/event-stream" },
        }),
    );
    const calls: string[] = [];
    const connection = fetchTransport("/s", { fetch: fetchImpl })(null, {
      onOpen: () => calls.push("open"),
      onActivity: () => calls.push("activity"),
      onMessage: () => calls.push("message"),
      onEnd: (outcome) => calls.push(outcome),
    });
    await settle();
    await settle();
    expect(calls).toEqual(["open", "activity"]);
    connection.close();
    cancel?.();
    await settle();
    await settle();
    expect(calls).toEqual(["open", "activity"]);
  });
});

// ── Against a real hearth ───────────────────────────────────────────────────

/** Wait, in real time, until `check` holds. */
async function eventually(
  check: () => boolean,
  withinMs = 5000,
): Promise<void> {
  const deadline = performance.now() + withinMs;
  while (!check()) {
    if (performance.now() > deadline)
      throw new Error(`not within ${withinMs} ms`);
    await new Promise((done) => setTimeout(done, 10));
  }
}

describe("client against a real hearth", () => {
  test("a cut connection resumes with the last id and the server sends no second snapshot", async () => {
    const hearth = await startTestHearth({ api: { streamPollMs: 20 } });
    const cuts: AbortController[] = [];
    const requests: Array<string | null> = [];
    const perConnection: string[][] = [];
    const real = fetchTransport(`${hearth.api}/stream`, {
      headers: { Origin: hearth.hearth.url },
      // Every request can be cut from here, as a dropped network would cut it.
      fetch: ((input: string | URL | Request, init?: RequestInit) => {
        const cut = new AbortController();
        cuts.push(cut);
        const headers = (init?.headers ?? {}) as Record<string, string>;
        requests.push(headers["Last-Event-ID"] ?? null);
        return fetch(input, {
          ...init,
          signal: init?.signal
            ? AbortSignal.any([init.signal, cut.signal])
            : cut.signal,
        });
        // justification: only the call signature the transport uses is implemented.
      }) as typeof fetch,
    });
    const client = createStreamClient({
      transport: (id, handlers) => {
        const seen: string[] = [];
        perConnection.push(seen);
        return real(id, {
          ...handlers,
          onMessage(message) {
            seen.push(message.event);
            handlers.onMessage(message);
          },
        });
      },
      read: async (path) =>
        (await fetch(`${hearth.api}${path}`, {
          headers: { Origin: hearth.hearth.url },
        }).then((response) => response.json())) as OperatorEnvelope<unknown>,
      random: () => 0,
    });
    const leave = client.subscribe(() => undefined);
    try {
      await eventually(() => client.getState().status === "live");
      expect(perConnection[0]).toEqual(["snapshot"]);
      const start = client.getState().cursor ?? -1;

      const first = hearth.append({
        kind: "gate.ran",
        payload: { gate: "tsc", passed: true },
      });
      await eventually(() => client.getState().cursor === first);
      expect(first).toBeGreaterThan(start);

      // Cut the connection. An event is written while the client is away.
      cuts[0]?.abort();
      await eventually(() => client.getState().status === "reconnecting");
      const missed = hearth.append({
        kind: "reservation.acquired",
        beadId: "b-1",
        payload: { worktree: "wt", globs: ["docs/**"] },
      });

      await eventually(() => client.getState().cursor === missed);
      expect(client.getState().status).toBe("live");
      expect(requests).toEqual([null, String(first)]);
      // The second connection carried the missed event and no snapshot.
      expect(perConnection[1]).toEqual(["delta"]);
      expect(client.getState().reservations.data?.map((r) => r.beadId)).toEqual(
        ["b-1"],
      );
    } finally {
      leave();
      await hearth.close();
    }
  }, 20_000);

  test("a route that answers something other than a stream turns live updates off after one request", async () => {
    const hearth = await startTestHearth();
    let asked = 0;
    const client = createStreamClient({
      // The health route answers JSON, as a host with no stream route would answer a page.
      transport: fetchTransport(`${hearth.api}/health`, {
        fetch: ((input: string | URL | Request, init?: RequestInit) => {
          asked += 1;
          return fetch(input, init);
          // justification: only the call signature the transport uses is implemented.
        }) as typeof fetch,
      }),
      read: () => Promise.reject(new Error("unused")),
    });
    const leave = client.subscribe(() => undefined);
    try {
      await eventually(() => client.getState().status === "off");
      expect(client.getState().offReason).toBe("no-hearth");
      await new Promise((done) => setTimeout(done, 700));
      expect(asked).toBe(1);
    } finally {
      leave();
      await hearth.close();
    }
  }, 20_000);
});

// ── What the page draws ─────────────────────────────────────────────────────

describe("the notice and the live stat cards", () => {
  test("no notice while live updates work or are still being set up", () => {
    for (const status of ["connecting", "live", "reconnecting"] as const)
      expect(LiveBannerView({ status, reason: null })).toBeNull();
  });

  test("off for want of a control plane: one polite status line that says what still works", () => {
    const banner = LiveBannerView({ status: "off", reason: "no-hearth" });
    expect(tag(banner)).toBe("p");
    expect(attrs(banner)).toMatchObject({
      class: "af-notice",
      role: "status",
      "data-testid": "live-banner",
    });
    expect(textOf(banner)).toContain("Live updates are off");
    expect(textOf(banner)).toContain("the data it was built with");
  });

  test("off after a lost connection says so, and how to connect again", () => {
    const banner = LiveBannerView({ status: "off", reason: "lost" });
    expect(textOf(banner)).toContain("Live updates stopped");
    expect(textOf(banner)).toContain("Reload the page");
  });

  test("no live cards without live numbers", () => {
    expect(LiveStatsView({ stats: null })).toBeNull();
  });

  test("four labelled cards, and a dash where a collection could not be read", () => {
    const row = LiveStatsView({
      stats: { runsInFlight: 2, openSessions: 0, queued: null, claims: 1 },
    });
    expect(attrs(row)).toMatchObject({
      class: "af-stat-row",
      "aria-label": "Live from the control plane",
    });
    const cards = findAll(row, "StatCard").map((card) => [
      card.props["label"],
      card.props["value"],
    ]);
    expect(cards).toEqual([
      ["Runs in flight", 2],
      ["Open sessions", 0],
      ["Queued beads", "–"],
      ["File claims held", 1],
    ]);
  });
});
