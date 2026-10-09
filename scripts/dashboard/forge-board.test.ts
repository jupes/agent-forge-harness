import { describe, expect, test } from "bun:test";
import {
  boardRows,
  type ForgeRunView,
  type GateRun,
  runHealth,
} from "../../scripts/dashboard/forge-run-model";
import type { ForgePhase, ReviewRound } from "../../scripts/forge/phases";

const AT = "2026-09-18T12:00:00.000Z";

function phases(completed: ForgePhase[], missing: ForgePhase[] = []) {
  const all: ForgePhase[] = ["research", "plan", "implement", "ship"];
  const active = all.find((phase) => !completed.includes(phase)) ?? null;
  return all.map((id) => ({
    id,
    state: completed.includes(id)
      ? ("complete" as const)
      : id === active
        ? ("active" as const)
        : ("locked" as const),
    artifact: null,
    artifactMissing: missing.includes(id),
  }));
}

/** A gate run correlated to run "alpha"; `over` turns it into another kind. */
function gate(passed: boolean, over: Partial<GateRun> = {}): GateRun {
  return {
    event: "TaskCompleted",
    timestamp: AT,
    passed,
    checks: [],
    checkout: "C:/work",
    branch: "feat/x",
    link: "linked",
    beadsIssueId: "bead-1",
    executionRunId: "alpha",
    unlinkedReason: null,
    host: null,
    taskId: null,
    forgeSlug: null,
    evaluatorVerdict: null,
    ...over,
  };
}

/** The same result as an entry from before entries had a schema version. */
const LEGACY: Partial<GateRun> = {
  link: "legacy",
  beadsIssueId: null,
  executionRunId: null,
  forgeSlug: "alpha",
};

function round(over: Partial<ReviewRound> = {}): ReviewRound {
  return {
    phase: "plan",
    round: 1,
    verdict: "PASS",
    findings: { blocker: 0, high: 0, medium: 0, low: 0 },
    at: AT,
    ...over,
  };
}

function view(over: Partial<ForgeRunView> = {}): ForgeRunView {
  return {
    slug: "alpha",
    feature: "Alpha feature",
    epic: "bd-1",
    mode: "gated",
    complete: false,
    updatedAt: AT,
    phases: phases(["research"]),
    reviews: [],
    gate: null,
    gateScope: { checkout: "C:/work", slug: "alpha" },
    ...over,
  };
}

describe("runHealth", () => {
  test("a shipped run reads as shipped, whatever else it carries", () => {
    expect(
      runHealth(
        view({
          complete: true,
          phases: phases(["research", "plan", "implement", "ship"]),
          gate: gate(false),
        }),
      ),
    ).toBe("shipped");
  });

  test("a run mid-pipeline with nothing wrong is running", () => {
    expect(runHealth(view())).toBe("running");
    expect(runHealth(view({ gate: gate(true) }))).toBe("running");
  });

  test("a failing quality gate wants attention", () => {
    expect(runHealth(view({ gate: gate(false) }))).toBe("attention");
  });

  test("a failing legacy gate stays on the run but does not decide how the run reads", () => {
    const run = view({ gate: gate(false, LEGACY) });
    expect(runHealth(run)).toBe("running");
    expect(boardRows([run])[0]?.gatePassed).toBeNull();
    // A correlated gate still counts, pass or fail.
    expect(boardRows([view({ gate: gate(false) })])[0]?.gatePassed).toBe(false);
  });

  test("a phase claiming an artifact that is gone wants attention", () => {
    expect(
      runHealth(view({ phases: phases(["research"], ["research"]) })),
    ).toBe("attention");
  });

  test("a failing latest review wants attention; an earlier failure that was fixed does not", () => {
    expect(runHealth(view({ reviews: [round({ verdict: "FAIL" })] }))).toBe(
      "attention",
    );
    expect(
      runHealth(view({ reviews: [round({ verdict: "UNREADABLE" })] })),
    ).toBe("attention");
    expect(
      runHealth(
        view({
          reviews: [
            round({ round: 1, verdict: "FAIL" }),
            round({ round: 2, verdict: "PASS" }),
          ],
        }),
      ),
    ).toBe("running");
  });
});

describe("boardRows", () => {
  test("a row carries what the board shows without opening the run", () => {
    const [row] = boardRows([
      view({
        mode: "auto",
        phases: phases(["research", "plan"]),
        reviews: [round({ phase: "research" }), round({ phase: "plan" })],
        gate: gate(true),
      }),
    ]);
    expect(row?.slug).toBe("alpha");
    expect(row?.mode).toBe("auto");
    expect(row?.health).toBe("running");
    expect(row?.completedCount).toBe(2);
    expect(row?.totalPhases).toBe(4);
    expect(row?.status).toBe("implement");
    expect(row?.reviewRounds).toBe(2);
    expect(row?.latestVerdict).toBe("PASS");
    expect(row?.gatePassed).toBe(true);
    expect(row?.phases).toHaveLength(4);
  });

  test("a shipped run reports shipped rather than a next phase", () => {
    const [row] = boardRows([
      view({
        complete: true,
        phases: phases(["research", "plan", "implement", "ship"]),
      }),
    ]);
    expect(row?.status).toBe("shipped");
    expect(row?.completedCount).toBe(4);
  });

  test("a run with no gate and no reviews says so rather than guessing", () => {
    const [row] = boardRows([view()]);
    expect(row?.gatePassed).toBeNull();
    expect(row?.reviewRounds).toBe(0);
    expect(row?.latestVerdict).toBeNull();
  });

  test("rows keep the order they are given, one per run", () => {
    const rows = boardRows([
      view({ slug: "beta" }),
      view({ slug: "alpha" }),
      view({ slug: "gamma", complete: true }),
    ]);
    expect(rows.map((r) => r.slug)).toEqual(["beta", "alpha", "gamma"]);
  });
});
