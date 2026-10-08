import { describe, expect, test } from "bun:test";
import type { ForgeState, ReviewRound } from "./phases";
import { reviewGate } from "./review-rules";

const AT = "2026-06-04T00:00:00.000Z";

function round(
  phase: ReviewRound["phase"],
  n: number,
  verdict: ReviewRound["verdict"],
  high = 0,
  extra: Partial<ReviewRound> = {},
): ReviewRound {
  return {
    phase,
    round: n,
    verdict,
    findings: { blocker: 0, high, medium: 0, low: 0 },
    at: AT,
    ...extra,
  };
}

function run(
  completed: ForgeState["completed"],
  reviews: ReviewRound[],
  mode: ForgeState["mode"] = "auto",
): ForgeState {
  return {
    slug: "demo",
    phase: completed[completed.length - 1] ?? "research",
    completed,
    artifacts: {},
    reviews,
    updatedAt: AT,
    ...(mode ? { mode } : {}),
  };
}

describe("reviewGate", () => {
  test("a gated run is always clear", () => {
    const rounds = [round("research", 1, "FAIL", 1)];
    expect(reviewGate(run(["research"], rounds, "gated"))).toEqual({
      status: "clear",
    });
  });

  test("a run with no recorded mode is always clear", () => {
    const { mode: _mode, ...noMode } = run(
      ["research"],
      [round("research", 1, "FAIL", 1)],
    );
    expect(reviewGate(noMode)).toEqual({ status: "clear" });
  });

  test("an auto run with nothing completed is clear", () => {
    expect(reviewGate(run([], []))).toEqual({ status: "clear" });
  });

  test("the last completed phase with no round is awaiting review", () => {
    expect(reviewGate(run(["research"], []))).toEqual({
      status: "awaiting-review",
      phase: "research",
    });
  });

  test("a failing first round is a revision with the loop's reason", () => {
    const gate = reviewGate(
      run(["research"], [round("research", 1, "FAIL", 2)]),
    );
    expect(gate).toMatchObject({ status: "revise", phase: "research" });
    if (gate.status === "revise") expect(gate.reason).toContain("revising");
  });

  test("an unreadable verdict halts", () => {
    const gate = reviewGate(
      run(["research"], [round("research", 1, "UNREADABLE")]),
    );
    expect(gate).toMatchObject({ status: "halted", phase: "research" });
  });

  test("the earliest held phase decides", () => {
    const gate = reviewGate(
      run(
        ["research", "plan"],
        [round("research", 1, "FAIL", 1), round("plan", 1, "UNREADABLE")],
      ),
    );
    expect(gate).toMatchObject({ status: "revise", phase: "research" });
  });

  test("a stored action wins over what the default rule would derive", () => {
    const gate = reviewGate(
      run(
        ["research"],
        [round("research", 1, "FAIL", 2, { action: "advance", reason: "x" })],
      ),
    );
    expect(gate).toEqual({ status: "clear" });
  });

  test("a stored halt without a reason still names the round", () => {
    const gate = reviewGate(
      run(["research"], [round("research", 1, "FAIL", 2, { action: "halt" })]),
    );
    expect(gate).toMatchObject({ status: "halted", phase: "research" });
    if (gate.status === "halted") expect(gate.reason).toContain("round 1");
  });

  test("rounds for a phase not yet completed do not hold the run", () => {
    const gate = reviewGate(
      run(
        ["research"],
        [round("research", 1, "PASS"), round("plan", 1, "FAIL", 3)],
      ),
    );
    expect(gate).toEqual({ status: "clear" });
  });
});

describe("the import boundary", () => {
  async function specifiers(file: string): Promise<string[]> {
    const source = await Bun.file(new URL(file, import.meta.url)).text();
    return [...source.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1] ?? "");
  }

  test("review-rules.ts imports only the phases module", async () => {
    const imports = await specifiers("./review-rules.ts");
    expect(imports).not.toHaveLength(0);
    for (const specifier of imports) expect(specifier).toBe("./phases");
  });

  test("runs.ts and phases.ts do not import the ledger", async () => {
    for (const file of ["./runs.ts", "./phases.ts"]) {
      const imports = await specifiers(file);
      expect(imports).not.toHaveLength(0);
      for (const specifier of imports) {
        expect(specifier).not.toContain("ledger");
        expect(specifier).not.toContain("sqlite");
      }
    }
  });

  test("phase-gate.ts, auto-loop.ts and runs-cli.ts have no static import of the ledger", async () => {
    // Their pure exports are imported by the hooks and by each other; the
    // ledger is loaded with a dynamic import only when a CLI actually runs.
    for (const file of ["./phase-gate.ts", "./auto-loop.ts", "./runs-cli.ts"]) {
      for (const specifier of await specifiers(file)) {
        expect(specifier).not.toContain("ledger");
        expect(specifier).not.toContain("sqlite");
      }
    }
  });
});
