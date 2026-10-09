import { describe, expect, test } from "bun:test";
import { recordRound } from "./auto-loop";
import {
  artifactPath,
  executorFromFlags,
  type ForgeState,
  isRunComplete,
  nextPhase,
  parseState,
  phaseCommand,
  prereqPhase,
  recordComplete,
  validateEnter,
} from "./phase-gate";
import type { ReviewRound } from "./phases";
import { summarizeRun } from "./runs";

const NEVER = () => false;
const ALWAYS = () => true;
const FIXED = () => "2026-06-04T00:00:00.000Z";

function stateAfter(
  completed: ForgeState["completed"],
  slug = "demo",
): ForgeState {
  return {
    slug,
    phase: completed[completed.length - 1] ?? "research",
    completed,
    artifacts: {},
    updatedAt: FIXED(),
  };
}

describe("phase topology", () => {
  test("artifact paths key off the slug", () => {
    expect(artifactPath("research", "x")).toBe("plans/research/x.md");
    expect(artifactPath("plan", "x")).toBe("plans/drafts/x.md");
    expect(artifactPath("ship", "x")).toBe("reports/x-ship.md");
  });

  test("implement has no document artifact", () => {
    expect(artifactPath("implement", "x")).toBeNull();
  });

  test("prereq and next chain through the pipeline", () => {
    expect(prereqPhase("research")).toBeNull();
    expect(prereqPhase("plan")).toBe("research");
    expect(prereqPhase("ship")).toBe("implement");
    expect(nextPhase("research")).toBe("plan");
    expect(nextPhase("ship")).toBeNull();
  });

  test("phaseCommand renders the slash command", () => {
    expect(phaseCommand("plan", "user-settings")).toBe(
      "/forge-plan user-settings",
    );
  });
});

describe("validateEnter", () => {
  test("research can always start", () => {
    expect(validateEnter("research", "x", NEVER, null).ok).toBe(true);
  });

  test("plan is blocked when the research artifact is missing", () => {
    const r = validateEnter("plan", "x", NEVER, null);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("/forge-research x");
  });

  test("plan is allowed when the research artifact exists on disk", () => {
    const exists = (p: string) => p === "plans/research/x.md";
    expect(validateEnter("plan", "x", exists, null).ok).toBe(true);
  });

  test("ship is allowed when implement is recorded complete (no artifact)", () => {
    const state = stateAfter(["research", "plan", "implement"]);
    expect(validateEnter("ship", "demo", NEVER, state).ok).toBe(true);
  });

  test("ship is blocked when implement is not complete", () => {
    const state = stateAfter(["research", "plan"]);
    expect(validateEnter("ship", "demo", NEVER, state).ok).toBe(false);
  });
});

describe("recordComplete", () => {
  test("records a phase and stores its artifact path", () => {
    const r = recordComplete("research", "demo", ALWAYS, null, {}, FIXED);
    expect(r.ok).toBe(true);
    expect(r.data?.completed).toEqual(["research"]);
    expect(r.data?.artifacts.research).toBe("plans/research/demo.md");
  });

  test("fails loudly when the phase artifact is missing", () => {
    const r = recordComplete(
      "plan",
      "demo",
      NEVER,
      stateAfter(["research"]),
      {},
      FIXED,
    );
    expect(r.ok).toBe(false);
    expect(r.error).toContain("plans/drafts/demo.md");
  });

  test("implement completes without an artifact", () => {
    const r = recordComplete(
      "implement",
      "demo",
      NEVER,
      stateAfter(["research", "plan"]),
      {},
      FIXED,
    );
    expect(r.ok).toBe(true);
    expect(r.data?.completed).toContain("implement");
  });

  test("rejects a slug mismatch against the active run", () => {
    const r = recordComplete(
      "plan",
      "other",
      ALWAYS,
      stateAfter(["research"], "demo"),
      {},
      FIXED,
    );
    expect(r.ok).toBe(false);
    expect(r.error).toContain("other");
  });

  test("does not double-add an already-completed phase", () => {
    const first = recordComplete(
      "research",
      "demo",
      ALWAYS,
      null,
      {},
      FIXED,
    ).data;
    const again = recordComplete("research", "demo", ALWAYS, first, {}, FIXED);
    expect(again.data?.completed).toEqual(["research"]);
  });
});

describe("state parsing", () => {
  test("round-trips a valid state", () => {
    const s = stateAfter(["research", "plan"]);
    expect(parseState(JSON.stringify(s))?.completed).toEqual([
      "research",
      "plan",
    ]);
  });

  test("returns null for invalid JSON or shape", () => {
    expect(parseState("not json")).toBeNull();
    expect(parseState(JSON.stringify({ slug: "x" }))).toBeNull();
  });

  test("drops unknown phase values defensively", () => {
    const parsed = parseState(
      JSON.stringify({
        slug: "x",
        phase: "plan",
        completed: ["research", "bogus"],
      }),
    );
    expect(parsed?.completed).toEqual(["research"]);
  });

  test("isRunComplete is true only after ship", () => {
    expect(isRunComplete(stateAfter(["research", "plan", "implement"]))).toBe(
      false,
    );
    expect(
      isRunComplete(stateAfter(["research", "plan", "implement", "ship"])),
    ).toBe(true);
  });
});

describe("the review ledger survives the pipeline", () => {
  test("advancing a phase keeps the rounds recorded so far", () => {
    const withReviews: ForgeState = {
      ...stateAfter(["research"]),
      reviews: [
        {
          phase: "research",
          round: 1,
          verdict: "PASS",
          findings: { blocker: 0, high: 0, medium: 1, low: 0 },
          at: FIXED(),
        },
      ],
    };
    const r = recordComplete("plan", "demo", ALWAYS, withReviews, {}, FIXED);
    expect(r.data?.reviews).toHaveLength(1);
    expect(r.data?.reviews?.[0]?.phase).toBe("research");
  });

  test("mode and checkout carry forward once recorded", () => {
    const first = recordComplete(
      "research",
      "demo",
      ALWAYS,
      null,
      { mode: "auto", checkout: "C:/trees/aa11" },
      FIXED,
    ).data;
    const second = recordComplete("plan", "demo", ALWAYS, first, {}, FIXED);
    expect(second.data?.mode).toBe("auto");
    expect(second.data?.checkout).toBe("C:/trees/aa11");
  });
});

describe("an auto run's reviews gate the next phase", () => {
  const round = (
    phase: ReviewRound["phase"],
    n: number,
    verdict: ReviewRound["verdict"],
    high = 0,
  ): ReviewRound => ({
    phase,
    round: n,
    verdict,
    findings: { blocker: 0, high, medium: 0, low: 0 },
    at: FIXED(),
  });

  const haltedPlan: ForgeState = {
    ...stateAfter(["research", "plan"]),
    mode: "auto",
    reviews: [
      round("research", 1, "PASS"),
      round("plan", 1, "FAIL", 1),
      round("plan", 2, "FAIL", 1),
    ],
  };

  test("the following phase cannot start while the prior phase is halted", () => {
    const r = validateEnter("implement", "demo", ALWAYS, haltedPlan);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('"plan" is halted');
    expect(r.error).toContain("not converging");
    expect(r.error).toContain("/forge-plan demo");
    expect(r.error).toContain("bun run forge:review --slug demo --phase plan");
  });

  test("the following phase cannot start while the prior phase is awaiting review", () => {
    const unreviewed: ForgeState = {
      ...stateAfter(["research", "plan"]),
      mode: "auto",
      reviews: [round("research", 1, "PASS")],
    };
    const r = validateEnter("implement", "demo", ALWAYS, unreviewed);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('"plan" has not been reviewed');
    expect(r.error).toContain("bun run forge:review --slug demo --phase plan");
  });

  test("the halted phase itself can be re-entered", () => {
    expect(validateEnter("plan", "demo", ALWAYS, haltedPlan).ok).toBe(true);
  });

  test("a gated run with the same rounds may start the following phase", () => {
    const gated: ForgeState = { ...haltedPlan, mode: "gated" };
    expect(validateEnter("implement", "demo", ALWAYS, gated).ok).toBe(true);
  });

  test("phase-gate --write does not clear a halt; a new advancing round does", () => {
    // Exercises recordComplete, the function behind --write, not the CLI.
    const rewritten = recordComplete(
      "plan",
      "demo",
      ALWAYS,
      haltedPlan,
      {},
      FIXED,
    ).data as ForgeState;
    expect(summarizeRun(rewritten).halted?.phase).toBe("plan");
    expect(validateEnter("implement", "demo", ALWAYS, rewritten).ok).toBe(
      false,
    );

    const cleared = recordRound(rewritten, round("plan", 3, "PASS"));
    expect(summarizeRun(cleared).halted).toBeNull();
    expect(summarizeRun(cleared).next).toBe("implement");
    expect(validateEnter("implement", "demo", ALWAYS, cleared).ok).toBe(true);
  });
});

describe("the executor and bead on a run", () => {
  test("recording a phase stores the executor and bead it was given and keeps them on the next write", () => {
    const executor = { provider: "claude", model: "m-1", effort: "high" };
    const first = recordComplete(
      "research",
      "demo",
      ALWAYS,
      null,
      { executor, beadId: "bd-7" },
      FIXED,
    ).data;
    expect(first?.schemaVersion).toBe(2);
    expect(first?.executor).toEqual(executor);
    expect(first?.beadId).toBe("bd-7");

    const second = recordComplete("plan", "demo", ALWAYS, first, {}, FIXED);
    expect(second.data?.executor).toEqual(executor);
    expect(second.data?.beadId).toBe("bd-7");
  });

  test("a later executor or bead replaces the stored one", () => {
    const first = recordComplete(
      "research",
      "demo",
      ALWAYS,
      null,
      { executor: { provider: "claude", model: "m-1" }, beadId: "bd-7" },
      FIXED,
    ).data;
    const second = recordComplete(
      "plan",
      "demo",
      ALWAYS,
      first,
      { executor: { provider: "codex", model: "m-2" }, beadId: "bd-8" },
      FIXED,
    ).data;
    expect(second?.executor).toEqual({ provider: "codex", model: "m-2" });
    expect(second?.beadId).toBe("bd-8");
  });

  test("the announced review status carries across a write", () => {
    const base: ForgeState = {
      ...stateAfter(["research"]),
      announcedPhase: "research",
      announcedStatus: "awaiting-review",
    };
    const next = recordComplete("plan", "demo", ALWAYS, base, {}, FIXED).data;
    expect(next?.announcedStatus).toBe("awaiting-review");
  });

  test("executor flags need a provider and a model together", () => {
    expect(executorFromFlags({})).toEqual({
      ok: true,
      data: undefined,
      error: null,
    });
    expect(executorFromFlags({ provider: "claude" }).ok).toBe(false);
    expect(executorFromFlags({ model: "m-1" }).ok).toBe(false);
    expect(executorFromFlags({ effort: "high" }).ok).toBe(false);
    expect(executorFromFlags({ provider: "claude", model: "" }).ok).toBe(false);
    expect(
      executorFromFlags({
        provider: "claude",
        model: "m-1",
        effort: "high",
        smith: "anvil",
      }).data,
    ).toEqual({
      provider: "claude",
      model: "m-1",
      effort: "high",
      smith: "anvil",
    });
  });
});
