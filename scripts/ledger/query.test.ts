import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { LedgerEventInput } from "../../types/hearth";
import { appendEvent } from "./append";
import { closeLedger } from "./db";
import {
  activeReservations,
  lastEvent,
  latestEventId,
  listSessions,
  queryEventPage,
  queryEvents,
} from "./query";

const temporary: string[] = [];

function tempLedger(): string {
  const dir = mkdtempSync(join(tmpdir(), "ledger test "));
  temporary.push(dir);
  return join(dir, "ledger.db");
}

afterEach(() => {
  closeLedger();
  for (const dir of temporary.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

type Extra = Partial<
  Pick<LedgerEventInput, "workspace" | "beadId" | "runId" | "sessionId" | "ts">
>;

function tool(extra: Extra = {}): LedgerEventInput {
  return {
    kind: "tool.called",
    workspace: "c:/work/harness",
    payload: { tool: "Bash", argsHash: "sha256:ab12" },
    ...extra,
  };
}

function gate(extra: Extra = {}): LedgerEventInput {
  return {
    kind: "gate.ran",
    workspace: "c:/work/harness",
    payload: { gate: "typecheck", passed: true },
    ...extra,
  };
}

function phase(extra: Extra = {}): LedgerEventInput {
  return {
    kind: "run.phase.completed",
    workspace: "c:/work/harness",
    payload: { phase: "plan" },
    ...extra,
  };
}

/** Append the events in order and return the ledger path. */
function seed(events: LedgerEventInput[]): string {
  const path = tempLedger();
  for (const event of events) {
    const result = appendEvent(event, { path });
    if (!result.ok) throw new Error(result.error);
  }
  return path;
}

function ids(events: Array<{ id: number }>): number[] {
  return events.map((event) => event.id);
}

describe("queryEvents", () => {
  test("filters by bead", () => {
    const path = seed([
      tool({ beadId: "b-1" }),
      tool({ beadId: "b-2" }),
      gate({ beadId: "b-1" }),
    ]);
    expect(ids(queryEvents({ beadId: "b-1" }, { path }))).toEqual([1, 3]);
  });

  test("filters by run", () => {
    const path = seed([tool({ runId: "r-1" }), tool({ runId: "r-2" }), tool()]);
    expect(ids(queryEvents({ runId: "r-2" }, { path }))).toEqual([2]);
  });

  test("filters by session", () => {
    const path = seed([
      tool({ sessionId: "s-1" }),
      tool({ sessionId: "s-2" }),
      gate({ sessionId: "s-1" }),
    ]);
    expect(ids(queryEvents({ sessionId: "s-1" }, { path }))).toEqual([1, 3]);
  });

  test("filters by kind (several)", () => {
    const path = seed([tool(), gate(), phase(), gate()]);
    expect(
      ids(
        queryEvents({ kinds: ["gate.ran", "run.phase.completed"] }, { path }),
      ),
    ).toEqual([2, 3, 4]);
    expect(ids(queryEvents({ kinds: ["tool.called"] }, { path }))).toEqual([1]);
  });

  test("filters by since", () => {
    const path = seed([
      tool({ ts: "2026-10-01T00:00:00.000Z" }),
      tool({ ts: "2026-10-05T12:00:00.000Z" }),
      tool({ ts: "2026-10-06T00:00:00.000Z" }),
    ]);
    expect(
      ids(queryEvents({ since: "2026-10-05T12:00:00.000Z" }, { path })),
    ).toEqual([2, 3]);
    // The same instant written with an offset selects the same events.
    expect(
      ids(queryEvents({ since: "2026-10-05T14:00:00+02:00" }, { path })),
    ).toEqual([2, 3]);
  });

  test("filters by workspace", () => {
    const path = seed([
      tool({ workspace: "c:/work/harness" }),
      tool({ workspace: "c:/work/other" }),
    ]);
    expect(ids(queryEvents({ workspace: "c:/work/other" }, { path }))).toEqual([
      2,
    ]);
  });

  test("with no filter every event is returned in id order", () => {
    const path = seed([tool(), gate(), phase()]);
    expect(ids(queryEvents({}, { path }))).toEqual([1, 2, 3]);
  });

  test("pages with afterId and limit", () => {
    const path = seed([tool(), tool(), tool(), tool(), tool()]);
    expect(ids(queryEvents({ afterId: 0, limit: 2 }, { path }))).toEqual([
      1, 2,
    ]);
    expect(ids(queryEvents({ afterId: 2, limit: 2 }, { path }))).toEqual([
      3, 4,
    ]);
    expect(ids(queryEvents({ afterId: 4, limit: 2 }, { path }))).toEqual([5]);
    expect(ids(queryEvents({ afterId: 3 }, { path }))).toEqual([4, 5]);
  });

  test("a limit without a cursor returns the newest events, oldest first", () => {
    const path = seed([tool(), tool(), tool(), tool(), tool()]);
    expect(ids(queryEvents({ limit: 2 }, { path }))).toEqual([4, 5]);
  });

  test("--bead includes the other events of a session that touched the bead, and beadExact does not", () => {
    const path = seed([
      {
        kind: "session.started",
        workspace: "c:/work/harness",
        sessionId: "S",
        payload: { source: "startup" },
      },
      phase({ sessionId: "S", beadId: "B" }),
      tool({ sessionId: "T" }),
      tool({ sessionId: "S" }),
    ]);
    const joined = queryEvents({ beadId: "B" }, { path });
    expect(ids(joined)).toEqual([1, 2, 4]);
    expect(joined.map((event) => event.kind)).toEqual([
      "session.started",
      "run.phase.completed",
      "tool.called",
    ]);
    expect(
      ids(queryEvents({ beadId: "B", beadExact: true }, { path })),
    ).toEqual([2]);
  });

  test("a workspace written with backslashes and capitals is found when queried with slashes in lower case", () => {
    const path = seed([
      tool({ workspace: "C:\\Work\\Harness Repo\\" }),
      tool({ workspace: "c:/work/other" }),
    ]);
    const found = queryEvents({ workspace: "c:/work/harness repo" }, { path });
    expect(ids(found)).toEqual([1]);
    expect(found[0]?.workspace).toBe("c:/work/harness repo");
    expect(
      ids(queryEvents({ workspace: "C:\\WORK\\Harness Repo" }, { path })),
    ).toEqual([1]);
  });
});

describe("lastEvent", () => {
  test("returns the newest event of the given kinds for a run, or null", () => {
    const path = seed([
      phase({ runId: "r-1" }),
      gate({ runId: "r-1" }),
      phase({ runId: "r-2" }),
      tool({ runId: "r-1" }),
    ]);
    expect(
      lastEvent(
        { runId: "r-1", kinds: ["run.phase.completed", "gate.ran"] },
        {
          path,
        },
      )?.id,
    ).toBe(2);
    expect(
      lastEvent({ runId: "r-9", kinds: ["gate.ran"] }, { path }),
    ).toBeNull();
  });
});

const W = "c:/work/harness";

function started(sessionId: string, extra: Extra = {}): LedgerEventInput {
  return {
    kind: "session.started",
    workspace: W,
    sessionId,
    payload: { kind: "interactive", worktree: "c:/work/harness/trees/a" },
    ...extra,
  };
}

function ended(sessionId: string, extra: Extra = {}): LedgerEventInput {
  return {
    kind: "session.ended",
    workspace: W,
    sessionId,
    payload: { reason: "exit" },
    ...extra,
  };
}

describe("queryEventPage", () => {
  test("says whether more matched than the limit, for a tail and for a page after a cursor", () => {
    const path = seed([tool(), tool(), tool(), tool(), tool()]);
    // A tail keeps the newest and reports that older ones were left out.
    const tail = queryEventPage({ limit: 2 }, { path });
    expect(ids(tail.events)).toEqual([4, 5]);
    expect(tail.more).toBe(true);
    // A page after a cursor keeps the first and reports that more follow.
    const page = queryEventPage({ afterId: 1, limit: 2 }, { path });
    expect(ids(page.events)).toEqual([2, 3]);
    expect(page.more).toBe(true);
    // Exactly the limit is not "more".
    expect(queryEventPage({ afterId: 3, limit: 2 }, { path })).toMatchObject({
      more: false,
    });
    expect(ids(queryEventPage({ limit: 5 }, { path }).events)).toEqual([
      1, 2, 3, 4, 5,
    ]);
    expect(queryEventPage({ limit: 5 }, { path }).more).toBe(false);
    // Filters apply before the cut.
    const none = queryEventPage({ limit: 1, kinds: ["gate.ran"] }, { path });
    expect(none).toEqual({ events: [], more: false });
  });
});

describe("latestEventId", () => {
  test("is the newest id in the workspace, and 0 for an empty one", () => {
    const path = seed([
      tool(),
      tool({ workspace: "c:/work/other" }),
      tool(),
      tool({ workspace: "c:/work/other" }),
    ]);
    expect(latestEventId({ workspace: W }, { path })).toBe(3);
    expect(latestEventId({ workspace: "c:/work/other" }, { path })).toBe(4);
    expect(latestEventId({ workspace: "c:/work/none" }, { path })).toBe(0);
    expect(latestEventId({}, { path })).toBe(4);
  });
});

describe("listSessions", () => {
  test("folds the events of each session into one summary, newest first", () => {
    const executor = { provider: "claude", model: "claude-opus-5-5" };
    const path = seed([
      started("s-1", { ts: "2026-10-01T10:00:00.000Z" }),
      tool({ sessionId: "s-1", ts: "2026-10-01T10:01:00.000Z" }),
      started("s-2", { ts: "2026-10-01T11:00:00.000Z" }),
      {
        ...tool({
          sessionId: "s-1",
          beadId: "b-7",
          runId: "r-7",
          ts: "2026-10-01T11:30:00.000Z",
        }),
        executor: { ...executor, effort: "high", smith: "claude-master" },
      },
      ended("s-2", { ts: "2026-10-01T12:00:00.000Z" }),
    ]);
    expect(listSessions({ workspace: W }, { path })).toEqual([
      {
        sessionId: "s-2",
        workspace: W,
        kind: "interactive",
        worktree: "c:/work/harness/trees/a",
        startedAt: "2026-10-01T11:00:00.000Z",
        lastEventAt: "2026-10-01T12:00:00.000Z",
        endedAt: "2026-10-01T12:00:00.000Z",
      },
      {
        sessionId: "s-1",
        workspace: W,
        kind: "interactive",
        worktree: "c:/work/harness/trees/a",
        startedAt: "2026-10-01T10:00:00.000Z",
        lastEventAt: "2026-10-01T11:30:00.000Z",
        executor: {
          ...executor,
          effort: "high",
          smith: "claude-master",
          sessionId: "s-1",
        },
        beadId: "b-7",
        runId: "r-7",
      },
    ]);
  });

  test("a session is ended only while its newest event is the end: one that carried on reads as open", () => {
    const path = seed([
      started("s-1"),
      ended("s-1"),
      tool({ sessionId: "s-1" }),
      started("s-2"),
      ended("s-2"),
    ]);
    const sessions = listSessions({ workspace: W }, { path });
    expect(
      sessions.map((session) => [session.sessionId, "endedAt" in session]),
    ).toEqual([
      ["s-2", true],
      ["s-1", false],
    ]);
    expect(
      listSessions({ workspace: W, open: true }, { path }).map(
        (session) => session.sessionId,
      ),
    ).toEqual(["s-1"]);
  });

  test("a session the ledger never saw start has no start, kind or worktree; a child names its parent", () => {
    const path = seed([
      tool({ sessionId: "orphan" }),
      {
        kind: "session.started",
        workspace: W,
        sessionId: "p-1:reviewer",
        payload: { kind: "subagent", parentSessionId: "p-1" },
      },
    ]);
    const [child, orphan] = listSessions({ workspace: W }, { path });
    expect(child).toMatchObject({
      sessionId: "p-1:reviewer",
      kind: "subagent",
      parentSessionId: "p-1",
    });
    expect(orphan?.sessionId).toBe("orphan");
    expect(orphan).not.toHaveProperty("startedAt");
    expect(orphan).not.toHaveProperty("kind");
    expect(orphan).not.toHaveProperty("worktree");
    expect(orphan).not.toHaveProperty("executor");
  });

  test("is scoped to the workspace, capped by limit, and looks only at the newest events of the window", () => {
    const path = seed([
      started("old"),
      started("mid"),
      started("elsewhere", { workspace: "c:/work/other" }),
      tool({ sessionId: "new-1" }),
      tool({ sessionId: "new-2" }),
      tool(),
    ]);
    const all = listSessions({ workspace: W }, { path });
    expect(all.map((session) => session.sessionId)).toEqual([
      "new-2",
      "new-1",
      "mid",
      "old",
    ]);
    expect(
      listSessions({ workspace: W, limit: 2 }, { path }).map(
        (session) => session.sessionId,
      ),
    ).toEqual(["new-2", "new-1"]);
    // The window counts the events of this workspace: its newest three are
    // the event with no session and the two tool calls.
    expect(
      listSessions({ workspace: W, window: 3 }, { path }).map(
        (session) => session.sessionId,
      ),
    ).toEqual(["new-2", "new-1"]);
    expect(
      listSessions({ workspace: "c:/work/other" }, { path }).map(
        (session) => session.sessionId,
      ),
    ).toEqual(["elsewhere"]);
  });
});

describe("activeReservations", () => {
  const claim = (
    kind: "reservation.acquired" | "reservation.released",
    beadId: string | undefined,
    worktree: string,
    extra: Extra = {},
  ): LedgerEventInput => ({
    kind,
    workspace: W,
    ...(beadId !== undefined ? { beadId } : {}),
    payload: { worktree, globs: ["scripts/hearth/**"] },
    ...extra,
  });

  test("returns the claims acquired and not released, per bead and worktree", () => {
    const path = seed([
      claim("reservation.acquired", "b-1", "trees/a", {
        sessionId: "s-1",
        ts: "2026-10-01T10:00:00.000Z",
      }),
      claim("reservation.acquired", "b-2", "trees/b", {
        ts: "2026-10-01T10:05:00.000Z",
      }),
      claim("reservation.released", "b-1", "trees/a"),
      claim("reservation.acquired", "b-1", "trees/c", {
        ts: "2026-10-01T10:10:00.000Z",
      }),
      // Released in another worktree than it was acquired in: not this claim.
      claim("reservation.released", "b-2", "trees/elsewhere"),
      // No bead: it cannot form a reservation, and is left out.
      claim("reservation.acquired", undefined, "trees/d"),
      claim("reservation.acquired", "b-9", "trees/z", {
        workspace: "c:/work/other",
      }),
    ]);
    expect(activeReservations({ workspace: W }, { path })).toEqual([
      {
        beadId: "b-2",
        worktree: "trees/b",
        workspace: W,
        globs: ["scripts/hearth/**"],
        acquiredAt: "2026-10-01T10:05:00.000Z",
      },
      {
        beadId: "b-1",
        worktree: "trees/c",
        workspace: W,
        globs: ["scripts/hearth/**"],
        acquiredAt: "2026-10-01T10:10:00.000Z",
      },
    ]);
  });

  test("a claim acquired again after its release is held, with the later time and session", () => {
    const path = seed([
      claim("reservation.acquired", "b-1", "trees/a", {
        ts: "2026-10-01T10:00:00.000Z",
      }),
      claim("reservation.released", "b-1", "trees/a"),
      claim("reservation.acquired", "b-1", "trees/a", {
        sessionId: "s-2",
        ts: "2026-10-01T12:00:00.000Z",
      }),
    ]);
    expect(activeReservations({ workspace: W }, { path })).toEqual([
      {
        beadId: "b-1",
        worktree: "trees/a",
        workspace: W,
        globs: ["scripts/hearth/**"],
        sessionId: "s-2",
        acquiredAt: "2026-10-01T12:00:00.000Z",
      },
    ]);
  });
});
