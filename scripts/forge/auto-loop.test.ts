import { describe, expect, test } from "bun:test";
import {
  DEFAULT_MAX_REVISIONS,
  decideNext,
  haltHandoff,
  type ReviewRound,
  recordRound,
  reviewComment,
  roundFromVerdict,
} from "./auto-loop";
import { exitCodeFor } from "./auto-loop-cli";
import type { ForgeState } from "./phases";

const AT = "2026-06-04T00:00:00.000Z";

function round(
  over: Partial<ReviewRound> & Pick<ReviewRound, "round">,
): ReviewRound {
  return {
    phase: "plan",
    verdict: "FAIL",
    findings: { blocker: 0, high: 0, medium: 0, low: 0 },
    at: AT,
    ...over,
  };
}

const clean = { blocker: 0, high: 0, medium: 0, low: 0 };

describe("decideNext", () => {
  test("a phase with no review never advances", () => {
    const decision = decideNext({ phase: "plan", history: [] });
    expect(decision.action).toBe("halt");
    expect(decision.reason).toContain("No review recorded");
  });

  test("PASS advances", () => {
    const decision = decideNext({
      phase: "plan",
      history: [round({ round: 1, verdict: "PASS", findings: clean })],
    });
    expect(decision.action).toBe("advance");
    expect(decision.fileFollowUps).toBe(false);
  });

  test("PASS with medium or low findings advances and files follow-ups", () => {
    const decision = decideNext({
      phase: "plan",
      history: [
        round({
          round: 1,
          verdict: "PASS",
          findings: { ...clean, medium: 2, low: 1 },
        }),
      ],
    });
    expect(decision.action).toBe("advance");
    expect(decision.fileFollowUps).toBe(true);
  });

  test("FAIL on medium/low only advances and files follow-ups", () => {
    const decision = decideNext({
      phase: "plan",
      history: [round({ round: 1, findings: { ...clean, medium: 3 } })],
    });
    expect(decision.action).toBe("advance");
    expect(decision.fileFollowUps).toBe(true);
  });

  test("FAIL with a blocker revises while revisions remain", () => {
    const decision = decideNext({
      phase: "implement",
      history: [
        round({
          phase: "implement",
          round: 1,
          findings: { ...clean, blocker: 2 },
        }),
      ],
    });
    expect(decision.action).toBe("revise");
    expect(decision.nextRound).toBe(2);
  });

  test("the same failure twice halts rather than grinding", () => {
    const decision = decideNext({
      phase: "implement",
      history: [
        round({
          phase: "implement",
          round: 1,
          findings: { ...clean, high: 2 },
        }),
        round({
          phase: "implement",
          round: 2,
          findings: { ...clean, high: 2 },
        }),
      ],
    });
    expect(decision.action).toBe("halt");
    expect(decision.reason).toContain("not converging");
  });

  test("a failure that is shrinking keeps revising", () => {
    const decision = decideNext({
      phase: "implement",
      maxRevisions: 3,
      history: [
        round({
          phase: "implement",
          round: 1,
          findings: { ...clean, blocker: 3 },
        }),
        round({
          phase: "implement",
          round: 2,
          findings: { ...clean, blocker: 1 },
        }),
      ],
    });
    expect(decision.action).toBe("revise");
    expect(decision.nextRound).toBe(3);
  });

  test("the revision budget is a hard stop", () => {
    const history = [
      round({ round: 1, findings: { ...clean, blocker: 4 } }),
      round({ round: 2, findings: { ...clean, blocker: 3 } }),
      round({ round: 3, findings: { ...clean, blocker: 2 } }),
    ];
    const decision = decideNext({ phase: "plan", history });
    expect(DEFAULT_MAX_REVISIONS).toBe(2);
    expect(decision.action).toBe("halt");
    expect(decision.reason).toContain("2 revision");
  });

  test("an unusable verdict halts — an unattended run must not grade itself blind", () => {
    const decision = decideNext({
      phase: "plan",
      history: [round({ round: 1, verdict: "UNREADABLE" })],
    });
    expect(decision.action).toBe("halt");
    expect(decision.reason).toContain("usable verdict");
  });

  test("only this phase's rounds count", () => {
    const decision = decideNext({
      phase: "implement",
      history: [
        round({ phase: "plan", round: 1, findings: { ...clean, blocker: 9 } }),
        round({ phase: "plan", round: 2, findings: { ...clean, blocker: 9 } }),
        round({
          phase: "implement",
          round: 1,
          findings: { ...clean, blocker: 1 },
        }),
      ],
    });
    expect(decision.action).toBe("revise");
    expect(decision.nextRound).toBe(2);
  });
});

describe("roundFromVerdict", () => {
  test("numbers the round from this phase's history", () => {
    const first = roundFromVerdict({
      phase: "plan",
      history: [],
      verdict: {
        schemaVersion: 1,
        taskId: "t-1",
        verdict: "FAIL",
        findings: { ...clean, high: 1 },
      },
      at: AT,
    });
    expect(first.round).toBe(1);
    expect(first.verdict).toBe("FAIL");

    const second = roundFromVerdict({
      phase: "plan",
      history: [first, round({ phase: "ship", round: 1 })],
      verdict: null,
      at: AT,
      tier: "opus",
    });
    expect(second.round).toBe(2);
    expect(second.verdict).toBe("UNREADABLE");
    expect(second.tier).toBe("opus");
  });
});

describe("recordRound", () => {
  const state: ForgeState = {
    slug: "demo",
    phase: "plan",
    completed: ["research"],
    artifacts: {},
    updatedAt: AT,
  };

  test("appends to the ledger without touching the rest of the run", () => {
    const next = recordRound(state, round({ round: 1, verdict: "PASS" }));
    expect(next.reviews).toHaveLength(1);
    expect(next.completed).toEqual(["research"]);
    expect(next.slug).toBe("demo");
  });

  test("keeps earlier rounds, oldest first", () => {
    const one = recordRound(state, round({ round: 1 }));
    const two = recordRound(one, round({ round: 2, verdict: "PASS" }));
    expect(two.reviews?.map((r) => r.round)).toEqual([1, 2]);
  });
});

describe("what the run records for a human", () => {
  test("a review comment carries the verdict, the counts and the round", () => {
    expect(
      reviewComment(
        round({
          phase: "implement",
          round: 2,
          findings: { blocker: 1, high: 2, medium: 3, low: 4 },
        }),
      ),
    ).toBe(
      "review: FAIL — 1 blocker, 2 high, 3 medium, 4 low (implement round 2)",
    );
  });

  test("a halt writes down what stopped it and what to do next", () => {
    const history = [
      round({ round: 1, findings: { ...clean, blocker: 2 } }),
      round({ round: 2, findings: { ...clean, blocker: 2 } }),
    ];
    const text = haltHandoff({
      slug: "user-settings",
      phase: "plan",
      decision: decideNext({ phase: "plan", history }),
      history,
    });
    expect(text).toContain("user-settings");
    expect(text).toContain("not converging");
    expect(text).toContain("/forge-plan user-settings");
    expect(text).toContain("round 2");
  });
});

describe("exit codes let an unattended caller branch without parsing", () => {
  test("advance is 0, revise is 3, halt is 2", () => {
    expect(exitCodeFor("advance")).toBe(0);
    expect(exitCodeFor("revise")).toBe(3);
    expect(exitCodeFor("halt")).toBe(2);
  });
});
