import { describe, expect, test } from "bun:test";
import {
  describeEvent,
  EVENT_CAP,
  eventsPath,
  filterByKinds,
  kindCounts,
  mergeEvents,
  PAGE_LIMIT,
  parseTimelineHash,
  sessionPath,
  timelineHash,
  visibleWindow,
} from "../../docs/js/timeline-model";
import { LEDGER_EVENT_KINDS, type LedgerEvent } from "../../types/hearth";
import { EVENTS_MAX_LIMIT } from "../hearth/routes/operator-reads";

describe("the #/timeline hash", () => {
  test("a bead scope and kinds are read from the query", () => {
    expect(
      parseTimelineHash("#/timeline?bead=e2e-5&kind=gate.ran,tool.called"),
    ).toEqual({
      scope: { by: "bead", id: "e2e-5" },
      kinds: ["tool.called", "gate.ran"],
    });
  });

  test("a run scope is read; no kinds means none chosen", () => {
    expect(parseTimelineHash("#/timeline?run=my-run")).toEqual({
      scope: { by: "run", id: "my-run" },
      kinds: [],
    });
  });

  test("with both, the bead is the scope and the run is ignored", () => {
    expect(parseTimelineHash("#/timeline?run=r&bead=b").scope).toEqual({
      by: "bead",
      id: "b",
    });
  });

  test("an unknown kind is dropped and a repeated one counted once", () => {
    expect(
      parseTimelineHash("#/timeline?bead=b&kind=nope,gate.ran,gate.ran").kinds,
    ).toEqual(["gate.ran"]);
  });

  test("no scope, an empty id or no query reads as no scope", () => {
    expect(parseTimelineHash("#/timeline").scope).toBeNull();
    expect(parseTimelineHash("#/timeline?bead=").scope).toBeNull();
    expect(parseTimelineHash("#/timeline?kind=gate.ran")).toEqual({
      scope: null,
      kinds: ["gate.ran"],
    });
  });

  test("an id is decoded, and written back encoded to the same hash", () => {
    const hash = timelineHash({
      scope: { by: "bead", id: "a b&c" },
      kinds: ["gate.ran", "session.started"],
    });
    expect(hash).toBe(
      "#/timeline?bead=a+b%26c&kind=session.started%2Cgate.ran",
    );
    expect(parseTimelineHash(hash)).toEqual({
      scope: { by: "bead", id: "a b&c" },
      kinds: ["session.started", "gate.ran"],
    });
  });

  test("no scope and no kinds is the bare route", () => {
    expect(timelineHash({ scope: null, kinds: [] })).toBe("#/timeline");
  });
});

describe("the paths the timeline reads", () => {
  test("a scope's page after a cursor", () => {
    expect(eventsPath({ by: "bead", id: "e2e-5" }, 0)).toBe(
      `/events?bead=e2e-5&after=0&limit=${PAGE_LIMIT}`,
    );
    expect(eventsPath({ by: "run", id: "x y" }, 42)).toBe(
      `/events?run=x+y&after=42&limit=${PAGE_LIMIT}`,
    );
  });

  test("a session's events after a cursor, as many as asked", () => {
    expect(sessionPath("host:agent", 0, 1)).toBe(
      "/events?session=host%3Aagent&after=0&limit=1",
    );
  });

  test("a page is the most the hearth answers", () => {
    expect(PAGE_LIMIT).toBe(EVENTS_MAX_LIMIT);
  });
});

const event = (
  id: number,
  kind: LedgerEvent["kind"] = "tool.called",
  more: Partial<LedgerEvent> = {},
): LedgerEvent =>
  ({
    id,
    ulid: `u${id}`,
    ts: `2026-10-12T00:00:${String(id % 60).padStart(2, "0")}.000Z`,
    kind,
    workspace: "/w",
    payload: { tool: "Bash", argsHash: "h" },
    ...more,
  }) as LedgerEvent;

const ids = (events: readonly LedgerEvent[]): number[] =>
  events.map((entry) => entry.id);

describe("merging pages", () => {
  test("pages land in id order, each id once", () => {
    const merged = mergeEvents(
      [event(1), event(4)],
      [event(4), event(2), event(5)],
      10,
    );
    expect(ids(merged.events)).toEqual([1, 2, 4, 5]);
    expect(merged.cut).toBe(false);
  });

  test("past the cap the oldest are kept and the merge says it cut", () => {
    const merged = mergeEvents([event(1), event(2)], [event(3), event(4)], 3);
    expect(ids(merged.events)).toEqual([1, 2, 3]);
    expect(merged.cut).toBe(true);
  });

  test("exactly at the cap nothing is cut", () => {
    const merged = mergeEvents([event(1)], [event(2), event(3)], 3);
    expect(merged.cut).toBe(false);
  });

  test("the cap is ten thousand", () => {
    expect(EVENT_CAP).toBe(10_000);
  });
});

describe("kinds", () => {
  const events = [
    event(1, "gate.ran"),
    event(2, "tool.called"),
    event(3, "gate.ran"),
  ];

  test("each kind present is counted, in the ledger's order of kinds", () => {
    expect(kindCounts(events)).toEqual([
      { kind: "tool.called", count: 1 },
      { kind: "gate.ran", count: 2 },
    ]);
  });

  test("chosen kinds show only those events, in order", () => {
    expect(ids(filterByKinds(events, ["gate.ran"]))).toEqual([1, 3]);
  });

  test("no kind chosen shows every event", () => {
    expect(ids(filterByKinds(events, []))).toEqual([1, 2, 3]);
  });
});

describe("a line per event", () => {
  const cases: Array<[LedgerEvent["kind"], unknown, string]> = [
    [
      "session.started",
      { kind: "worker", worktree: "trees/a" },
      "session started (worker) in trees/a",
    ],
    [
      "session.ended",
      { reason: "stop", durationMs: 61_500 },
      "session ended: stop, after 61.5 s",
    ],
    [
      "tool.called",
      { tool: "Bash", argsHash: "h", exitCode: 1, durationMs: 250 },
      "Bash, exit 1, 250 ms",
    ],
    ["prompt.submitted", { hash: "h", length: 42 }, "prompt of 42 characters"],
    ["run.phase.entered", { phase: "plan" }, "entered plan"],
    [
      "run.phase.completed",
      { phase: "plan", artifact: "plans/drafts/x.md" },
      "completed plan: plans/drafts/x.md",
    ],
    [
      "review.recorded",
      {
        phase: "plan",
        round: 2,
        verdict: "FAIL",
        findings: { blocker: 0, high: 1, medium: 2, low: 3 },
        action: "revise",
      },
      "plan review 2: FAIL (0 blocker, 1 high, 2 medium, 3 low), revise",
    ],
    [
      "gate.ran",
      { gate: "typecheck", passed: false, exitCode: 2, durationMs: 1500 },
      "typecheck failed, exit 2, 1.5 s",
    ],
    [
      "verdict.bound",
      { verdict: "pass", summary: "fine" },
      "verdict pass: fine",
    ],
    [
      "bead.transitioned",
      { action: "comment", hash: "h", length: 12 },
      "comment (12 characters)",
    ],
    [
      "bead.transitioned",
      { from: null, to: "proposed", reason: "auto" },
      "queue: none → proposed (auto)",
    ],
    [
      "reservation.acquired",
      { worktree: "trees/a", globs: ["docs/**", "a.ts"] },
      "reserved docs/**, a.ts in trees/a",
    ],
    [
      "reservation.released",
      { worktree: "trees/a", globs: ["a.ts"] },
      "released a.ts in trees/a",
    ],
    [
      "shift.started",
      { shiftId: "s1", concurrency: 2 },
      "shift s1 started, 2 at a time",
    ],
    [
      "shift.stopped",
      { shiftId: "s1", reason: "drained" },
      "shift s1 stopped: drained",
    ],
    [
      "council.run.started",
      { councilRunId: "c1", profile: "default" },
      "council c1 started (default)",
    ],
    [
      "council.run.finished",
      { councilRunId: "c1", outcome: "fail", costUsd: 0.4 },
      "council c1 finished: fail, $0.40",
    ],
    ["friction.recorded", { frictionBeadId: "b-9" }, "friction filed as b-9"],
    [
      "operator.action",
      { action: "bead.comment", surface: "ui", target: "e2e-5" },
      "bead.comment via ui on e2e-5",
    ],
  ];

  for (const [kind, payload, line] of cases)
    test(`${kind}: ${line}`, () => {
      expect(
        describeEvent(event(1, kind, { payload } as Partial<LedgerEvent>)),
      ).toBe(line);
    });

  test("every kind has a line", () => {
    expect(new Set(cases.map(([kind]) => kind))).toEqual(
      new Set(LEDGER_EVENT_KINDS),
    );
  });

  test("optional parts are left out when absent", () => {
    expect(
      describeEvent(
        event(1, "session.started", { payload: {} } as Partial<LedgerEvent>),
      ),
    ).toBe("session started");
    expect(
      describeEvent(
        event(1, "tool.called", {
          payload: { tool: "Read", argsHash: "h" },
        } as Partial<LedgerEvent>),
      ),
    ).toBe("Read");
  });
});

describe("the rows in view", () => {
  const at = (scrollTop: number, count: number) =>
    visibleWindow({
      scrollTop,
      viewportPx: 440,
      rowPx: 44,
      count,
      overscan: 10,
    });

  test("at the top: the rows in view and the overscan below", () => {
    expect(at(0, 1000)).toEqual({ first: 0, last: 20 });
  });

  test("in the middle: overscan on both sides", () => {
    expect(at(4400, 1000)).toEqual({ first: 90, last: 120 });
  });

  test("at the end: clamped to the last row", () => {
    expect(at(990 * 44, 1000)).toEqual({ first: 980, last: 1000 });
  });

  test("a scroll position past the end, after the list shrank, shows the last rows", () => {
    expect(at(4400, 5)).toEqual({ first: 0, last: 5 });
    expect(at(1_000_000, 1000)).toEqual({ first: 980, last: 1000 });
  });

  test("no rows: an empty window", () => {
    expect(at(0, 0)).toEqual({ first: 0, last: 0 });
  });
});
