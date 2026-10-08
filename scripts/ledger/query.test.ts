import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { LedgerEventInput } from "../../types/hearth";
import { appendEvent } from "./append";
import { closeLedger } from "./db";
import { lastEvent, queryEvents } from "./query";

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
