import { describe, expect, test } from "bun:test";
import {
  artifactPath,
  type ForgeState,
  isRunComplete,
  nextPhase,
  parseState,
  phaseCommand,
  prereqPhase,
  recordComplete,
  validateEnter,
} from "./phase-gate";

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
