import { describe, expect, test } from "bun:test";
import { recordComplete } from "./phase-gate";
import type { ForgeState, ReviewRound } from "./phases";
import {
  activeRuns,
  byRecency,
  isValidSlug,
  legacyMigration,
  parseState,
  type RunSummary,
  runSlugFromFilename,
  runStatePath,
  summarizeRun,
} from "./runs";
import {
  announcedStatusFor,
  runLine,
  shouldAnnounce,
  stopAnnouncement,
} from "./runs-cli";

function state(
  slug: string,
  completed: ForgeState["completed"],
  updatedAt = "2026-06-04T00:00:00.000Z",
  extra: Partial<ForgeState> = {},
): ForgeState {
  return {
    slug,
    phase: completed[completed.length - 1] ?? "research",
    completed,
    artifacts: {},
    updatedAt,
    ...extra,
  };
}

describe("slug safety", () => {
  test("accepts the kebab-case slugs the pipeline derives", () => {
    expect(isValidSlug("user-settings")).toBe(true);
    expect(isValidSlug("proj-1234-add-sso")).toBe(true);
    expect(isValidSlug("v2.1_rollout")).toBe(true);
  });

  test("rejects anything that could escape the runs directory", () => {
    expect(isValidSlug("../../etc/passwd")).toBe(false);
    expect(isValidSlug("a/b")).toBe(false);
    expect(isValidSlug("a\b")).toBe(false);
    expect(isValidSlug("..")).toBe(false);
    expect(isValidSlug("-leading-dash")).toBe(false);
    expect(isValidSlug("")).toBe(false);
    expect(isValidSlug("x".repeat(200))).toBe(false);
  });

  test("runStatePath is null for an unsafe slug and a path for a safe one", () => {
    expect(runStatePath("../escape")).toBeNull();
    expect(runStatePath("demo")?.replaceAll("\\", "/")).toBe(
      ".tmp/work/forge-runs/demo.json",
    );
  });

  test("runSlugFromFilename reads back what runStatePath writes", () => {
    expect(runSlugFromFilename("demo.json")).toBe("demo");
    expect(runSlugFromFilename("notes.md")).toBeNull();
    expect(runSlugFromFilename("..json")).toBeNull();
  });
});

describe("run summaries", () => {
  test("next is the first phase not yet complete", () => {
    expect(summarizeRun(state("a", ["research"])).next).toBe("plan");
    expect(summarizeRun(state("a", [])).next).toBe("research");
  });

  test("a shipped run has no next phase and reads complete", () => {
    const done = summarizeRun(
      state("a", ["research", "plan", "implement", "ship"]),
    );
    expect(done.next).toBeNull();
    expect(done.complete).toBe(true);
  });

  test("mode defaults to gated and carries through when set", () => {
    expect(summarizeRun(state("a", [])).mode).toBe("gated");
    expect(summarizeRun(state("a", [], undefined, { mode: "auto" })).mode).toBe(
      "auto",
    );
  });

  test("two runs summarize independently", () => {
    const one = summarizeRun(state("alpha", ["research"]));
    const two = summarizeRun(state("beta", ["research", "plan", "implement"]));
    expect(one.slug).toBe("alpha");
    expect(one.next).toBe("plan");
    expect(two.slug).toBe("beta");
    expect(two.next).toBe("ship");
  });
});

describe("registry views", () => {
  const runs: RunSummary[] = [
    summarizeRun(state("old", ["research"], "2026-06-01T00:00:00.000Z")),
    summarizeRun(
      state(
        "done",
        ["research", "plan", "implement", "ship"],
        "2026-06-09T00:00:00.000Z",
      ),
    ),
    summarizeRun(
      state("new", ["research", "plan"], "2026-06-05T00:00:00.000Z"),
    ),
  ];

  test("activeRuns drops shipped runs", () => {
    expect(activeRuns(runs).map((r) => r.slug)).toEqual(["old", "new"]);
  });

  test("byRecency orders newest first without mutating the input", () => {
    const order = byRecency(runs).map((r) => r.slug);
    expect(order).toEqual(["done", "new", "old"]);
    expect(runs[0]?.slug).toBe("old");
  });
});

describe("legacy migration", () => {
  const legacy = JSON.stringify(state("legacy-run", ["research", "plan"]));

  test("moves a single-run state file into the per-run layout", () => {
    const move = legacyMigration({
      legacyJson: legacy,
      runExists: () => false,
    });
    expect(move?.slug).toBe("legacy-run");
    expect(move?.state.completed).toEqual(["research", "plan"]);
  });

  test("does not clobber a per-run file that already exists", () => {
    expect(
      legacyMigration({ legacyJson: legacy, runExists: () => true }),
    ).toBeNull();
  });

  test("ignores a missing or unreadable legacy file", () => {
    expect(
      legacyMigration({ legacyJson: null, runExists: () => false }),
    ).toBeNull();
    expect(
      legacyMigration({ legacyJson: "{ not json", runExists: () => false }),
    ).toBeNull();
  });

  test("refuses a legacy state whose slug is not filename-safe", () => {
    const hostile = JSON.stringify(state("../../escape", ["research"]));
    expect(
      legacyMigration({ legacyJson: hostile, runExists: () => false }),
    ).toBeNull();
  });
});

describe("the runs table", () => {
  test("a run reads as its progress and the command that continues it", () => {
    const line = runLine(
      summarizeRun(
        state("alpha", ["research", "plan"], "2026-06-04T00:00:00.000Z", {
          checkout: "C:/work/trees/aa11",
          mode: "auto",
          // An auto run is offered the next phase only once its reviews advance.
          reviews: [
            {
              phase: "research",
              round: 1,
              verdict: "PASS",
              findings: { blocker: 0, high: 0, medium: 0, low: 0 },
              at: "2026-06-04T00:00:00.000Z",
            },
            {
              phase: "plan",
              round: 1,
              verdict: "PASS",
              findings: { blocker: 0, high: 0, medium: 0, low: 0 },
              at: "2026-06-04T00:00:00.000Z",
            },
          ],
        }),
      ),
    );
    expect(line).toContain("alpha [auto]");
    expect(line).toContain("C:/work/trees/aa11");
    expect(line).toContain("completed: research → plan");
    expect(line).toContain("next: /forge-implement alpha");
  });

  test("a shipped run offers no next command", () => {
    const line = runLine(
      summarizeRun(state("done", ["research", "plan", "implement", "ship"])),
    );
    expect(line).toContain("next: shipped");
  });
});

describe("the pure half stays bundleable", () => {
  test("runs.ts imports no Node built-in", async () => {
    // The dashboard bundles this module for the browser through
    // forge-run-model.ts. An `fs` or `path` import here fails `vite build`
    // with "Module has been externalized for browser compatibility" — which is
    // a long way from this file, so guard it where the rule actually lives.
    const source = await Bun.file(new URL("./runs.ts", import.meta.url)).text();
    const imports = [...source.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
    expect(imports).not.toHaveLength(0);
    for (const specifier of imports) {
      expect(specifier).toMatch(/^\.{1,2}\//);
    }
  });
});

const AT = "2026-06-04T00:00:00.000Z";

function review(
  phase: ReviewRound["phase"],
  round: number,
  verdict: ReviewRound["verdict"],
  high = 0,
  extra: Partial<ReviewRound> = {},
): ReviewRound {
  return {
    phase,
    round,
    verdict,
    findings: { blocker: 0, high, medium: 0, low: 0 },
    at: AT,
    ...extra,
  };
}

function autoRun(
  completed: ForgeState["completed"],
  reviews: ReviewRound[],
  extra: Partial<ForgeState> = {},
): ForgeState {
  return state("alpha", completed, AT, { mode: "auto", reviews, ...extra });
}

describe("an auto run's reviews decide what comes next (csf2)", () => {
  test("an auto run whose plan review halted reports no next phase", () => {
    const summary = summarizeRun(
      autoRun(
        ["research", "plan"],
        [
          review("research", 1, "PASS"),
          review("plan", 1, "FAIL", 1),
          review("plan", 2, "FAIL", 1),
        ],
      ),
    );
    expect(summary.next).toBeNull();
    expect(summary.halted?.phase).toBe("plan");
    expect(summary.halted?.reason).toContain("not converging");
  });

  test("an auto run with a completed phase nobody reviewed keeps that phase as next", () => {
    const summary = summarizeRun(
      autoRun(["research", "plan"], [review("research", 1, "PASS")]),
    );
    expect(summary.next).toBe("plan");
    expect(summary.reviewPending).toBe("plan");
    expect(summary.halted).toBeNull();
  });

  test("a phase under revision stays next", () => {
    const summary = summarizeRun(
      autoRun(
        ["research", "plan"],
        [review("research", 1, "PASS"), review("plan", 1, "FAIL", 2)],
      ),
    );
    expect(summary.next).toBe("plan");
    expect(summary.reviewPending).toBe("plan");
    expect(summary.halted).toBeNull();
  });

  test("a gated run with the same history is unchanged", () => {
    const summary = summarizeRun(
      state("alpha", ["research", "plan"], AT, {
        mode: "gated",
        reviews: [
          review("research", 1, "PASS"),
          review("plan", 1, "FAIL", 1),
          review("plan", 2, "FAIL", 1),
        ],
      }),
    );
    expect(summary.next).toBe("implement");
    expect(summary.halted).toBeNull();
    expect(summary.reviewPending).toBeNull();
  });

  test("a halt decided under a non-default revision budget is reported as a halt", () => {
    // Highs 2 → 1 would revise under the default budget of 2; with
    // --max-revisions 1 the command halted, and stored that.
    const halted = summarizeRun(
      autoRun(
        ["research", "plan"],
        [
          review("research", 1, "PASS"),
          review("plan", 1, "FAIL", 2),
          review("plan", 2, "FAIL", 1, {
            action: "halt",
            reason: '1 revision round did not clear "plan".',
          }),
        ],
      ),
    );
    expect(halted.next).toBeNull();
    expect(halted.halted).toEqual({
      phase: "plan",
      reason: '1 revision round did not clear "plan".',
    });

    // Highs 3 → 2 → 1 would halt under the default budget; with a budget of 3
    // the command chose to revise, and stored that.
    const revising = summarizeRun(
      autoRun(
        ["research", "plan"],
        [
          review("research", 1, "PASS"),
          review("plan", 1, "FAIL", 3),
          review("plan", 2, "FAIL", 2),
          review("plan", 3, "FAIL", 1, {
            action: "revise",
            reason: "revising",
          }),
        ],
      ),
    );
    expect(revising.next).toBe("plan");
    expect(revising.halted).toBeNull();
  });

  test("a round whose stored action is not one of the three is read without it", () => {
    const text = JSON.stringify(
      autoRun(
        ["research"],
        [
          {
            ...review("research", 1, "PASS"),
            action: "proceed",
            reason: "kept",
          } as unknown as ReviewRound,
        ],
      ),
    );
    const parsed = parseState(text);
    expect(parsed?.reviews).toHaveLength(1);
    expect(parsed?.reviews?.[0]).not.toHaveProperty("action");
    expect(parsed?.reviews?.[0]?.reason).toBe("kept");
    expect(parsed?.reviews?.[0]?.verdict).toBe("PASS");
  });

  test("rounds recorded before actions were stored fall back to the default rule", () => {
    // Three failing rounds use up the default budget of two revisions.
    const summary = summarizeRun(
      autoRun(
        ["research"],
        [
          review("research", 1, "FAIL", 3),
          review("research", 2, "FAIL", 2),
          review("research", 3, "FAIL", 1),
        ],
      ),
    );
    expect(summary.next).toBeNull();
    expect(summary.halted?.phase).toBe("research");
    expect(summary.halted?.reason).toContain("2 revision rounds");
  });

  test("failing rounds followed by a passing one do not halt the run", () => {
    // The shape of a run reviewed with a larger budget before decisions were
    // stored: only the latest round of a phase decides.
    const summary = summarizeRun(
      autoRun(
        ["research", "plan"],
        [
          review("research", 1, "FAIL", 1),
          review("research", 2, "FAIL", 1),
          review("research", 3, "FAIL", 1),
          review("research", 4, "PASS"),
          review("plan", 1, "PASS"),
        ],
      ),
    );
    expect(summary.next).toBe("implement");
    expect(summary.halted).toBeNull();
    expect(summary.reviewPending).toBeNull();
  });

  test("an auto run whose reviews all advance reports the following phase and no halt", () => {
    const summary = summarizeRun(
      autoRun(
        ["research", "plan"],
        [review("research", 1, "PASS"), review("plan", 1, "PASS")],
      ),
    );
    expect(summary.next).toBe("implement");
    expect(summary.halted).toBeNull();
    expect(summary.reviewPending).toBeNull();
  });

  test("an earlier phase with no rounds does not hold a run whose latest phase was reviewed", () => {
    const summary = summarizeRun(
      autoRun(["research", "plan"], [review("plan", 1, "PASS")]),
    );
    expect(summary.next).toBe("implement");
    expect(summary.reviewPending).toBeNull();
  });
});

describe("how a held run is described", () => {
  const haltedPlan = autoRun(
    ["research", "plan"],
    [
      review("research", 1, "PASS"),
      review("plan", 1, "FAIL", 1),
      review("plan", 2, "FAIL", 1),
    ],
  );

  test("the runs table does not offer the next command for a halted run", () => {
    const line = runLine(summarizeRun(haltedPlan));
    expect(line).toContain("next: halted in plan");
    expect(line).toContain("not converging");
    expect(line).not.toContain("/forge-implement");
  });

  test("the runs table names the review a pending run is waiting on", () => {
    const line = runLine(
      summarizeRun(autoRun(["research"], [], { slug: "alpha" })),
    );
    expect(line).toContain(
      "next: review research (bun run forge:review --slug alpha --phase research",
    );
    expect(line).not.toContain("/forge-plan");
  });

  test("a phase whose last review asked for a revision reads as revise first, then review — not as awaiting a review", () => {
    const revising = summarizeRun(
      autoRun(["research"], [review("research", 1, "FAIL", 1)], {
        slug: "alpha",
      }),
    );
    const awaiting = summarizeRun(autoRun(["research"], [], { slug: "alpha" }));
    expect(revising.reviewPending).toBe("research");
    expect(revising.revising).toBe(true);
    expect(awaiting.revising).toBe(false);

    const command = "bun run forge:review --slug alpha --phase research";
    const line = runLine(revising);
    expect(line).toContain("next: revise research, then record a review (");
    expect(line).toContain(command);
    expect(line).not.toContain("next: review research");
    expect(runLine(awaiting)).toContain("next: review research (");
    expect(runLine(awaiting)).not.toContain("revise");

    const reminder = stopAnnouncement(revising);
    expect(reminder).toContain("Next: revise research, then record a review (");
    expect(reminder).toContain(command);
    expect(stopAnnouncement(awaiting)).toContain("Next: review research (");
    expect(stopAnnouncement(awaiting)).not.toContain("revise");
  });

  test("a halted or clear run is not revising", () => {
    expect(summarizeRun(haltedPlan).revising).toBe(false);
    expect(summarizeRun(state("beta", ["research"], AT)).revising).toBe(false);
  });

  test("the stop reminder text names the halt instead of the next phase", () => {
    const text = stopAnnouncement(summarizeRun(haltedPlan));
    expect(text).toContain("HALTED in plan");
    expect(text).toContain("not converging");
    expect(text).not.toContain("/forge-implement");
  });

  test("the stop reminder text for a clear run names the next phase command", () => {
    const text = stopAnnouncement(
      summarizeRun(state("beta", ["research"], AT)),
    );
    expect(text).toContain("Next: /forge-plan beta");
  });

  test("a halt after the phase was already announced is announced once more, then not again", () => {
    const announcedClear: ForgeState = {
      ...haltedPlan,
      announcedPhase: "plan",
      announcedStatus: "awaiting-review",
    };
    expect(shouldAnnounce(announcedClear)).toBe(true);
    const afterAnnouncing: ForgeState = {
      ...announcedClear,
      announcedStatus: announcedStatusFor(announcedClear),
    };
    expect(afterAnnouncing.announcedStatus).toBe("halted");
    expect(shouldAnnounce(afterAnnouncing)).toBe(false);
  });

  test("a passing review after a pending one is announced once", () => {
    const passed: ForgeState = {
      ...autoRun(
        ["research", "plan"],
        [review("research", 1, "PASS"), review("plan", 1, "PASS")],
      ),
      announcedPhase: "plan",
      announcedStatus: "awaiting-review",
    };
    expect(shouldAnnounce(passed)).toBe(true);
    expect(shouldAnnounce({ ...passed, announcedStatus: "clear" })).toBe(false);
  });

  test("a run announced before statuses were recorded is not announced again while it is clear", () => {
    const legacy: ForgeState = {
      ...state("beta", ["research"], AT),
      announcedPhase: "research",
    };
    expect(shouldAnnounce(legacy)).toBe(false);
  });

  test("an auto run whose ship review halted does not read shipped and stays in the active list", () => {
    const summary = summarizeRun(
      autoRun(
        ["research", "plan", "implement", "ship"],
        [
          review("research", 1, "PASS"),
          review("plan", 1, "PASS"),
          review("implement", 1, "PASS"),
          review("ship", 1, "UNREADABLE"),
        ],
      ),
    );
    expect(summary.complete).toBe(true);
    expect(summary.halted?.phase).toBe("ship");
    const line = runLine(summary);
    expect(line).toContain("next: halted in ship");
    expect(line).not.toContain("next: shipped");
    expect(activeRuns([summary]).map((r) => r.slug)).toEqual(["alpha"]);
  });

  test("a shipped auto run with no ship review round reads shipped and is not active", () => {
    // Runs shipped before the gate existed have no ship round, and some have
    // no rounds at all, or failing rounds on earlier phases.
    for (const reviews of [
      [],
      [review("research", 1, "PASS"), review("plan", 1, "PASS")],
      [review("plan", 1, "FAIL", 1), review("plan", 2, "FAIL", 1)],
    ]) {
      const summary = summarizeRun(
        autoRun(["research", "plan", "implement", "ship"], reviews),
      );
      expect(summary.next).toBeNull();
      expect(summary.halted).toBeNull();
      expect(summary.reviewPending).toBeNull();
      expect(runLine(summary)).toContain("next: shipped");
      expect(activeRuns([summary])).toEqual([]);
    }
  });
});

describe("run state v2", () => {
  const v1 = {
    slug: "legacy",
    phase: "plan",
    completed: ["research", "plan"],
    artifacts: {
      research: "plans/research/legacy.md",
      plan: "plans/drafts/legacy.md",
    },
    feature: "A feature",
    epic: "bd-1",
    mode: "auto",
    checkout: "C:/work/trees/with space",
    announcedPhase: "plan",
    reviews: [
      {
        phase: "research",
        round: 1,
        verdict: "FAIL",
        findings: { blocker: 0, high: 1, medium: 3, low: 5 },
        tier: "opus",
        summary: "first round",
        at: AT,
      },
      {
        phase: "research",
        round: 2,
        verdict: "PASS",
        findings: { blocker: 0, high: 0, medium: 2, low: 4 },
        tier: "opus",
        summary: "second round",
        at: AT,
      },
    ],
    updatedAt: AT,
  };

  test("a v1 state file is read as v2 without losing anything", () => {
    const parsed = parseState(JSON.stringify(v1));
    expect(parsed).toEqual({ ...v1, schemaVersion: 2 } as ForgeState);
  });

  test("an executor and bead id survive a read-modify-write", () => {
    const stored = {
      ...v1,
      beadId: "bd-1.2",
      executor: {
        provider: "claude",
        model: "m-1",
        effort: "high",
        sessionId: "s-1",
      },
    };
    const read = parseState(JSON.stringify(stored));
    const written = recordComplete(
      "implement",
      "legacy",
      () => true,
      read,
      {},
      () => AT,
    ).data;
    const reread = parseState(JSON.stringify(written));
    expect(reread?.schemaVersion).toBe(2);
    expect(reread?.beadId).toBe("bd-1.2");
    expect(reread?.executor).toEqual(stored.executor);
    expect(reread?.reviews).toEqual(v1.reviews as ReviewRound[]);
    expect(reread?.completed).toEqual(["research", "plan", "implement"]);
  });

  test("a malformed executor in the file is dropped, not trusted", () => {
    for (const executor of [
      { provider: "", model: "m-1" },
      { provider: "claude" },
      "claude",
      null,
    ]) {
      const parsed = parseState(JSON.stringify({ ...v1, executor }));
      expect(parsed).not.toBeNull();
      expect(parsed).not.toHaveProperty("executor");
      expect(parsed?.completed).toEqual(["research", "plan"]);
    }
  });

  test("an announced status outside the known ones is dropped", () => {
    expect(
      parseState(JSON.stringify({ ...v1, announcedStatus: "halted" }))
        ?.announcedStatus,
    ).toBe("halted");
    expect(
      parseState(JSON.stringify({ ...v1, announcedStatus: "stuck" })),
    ).not.toHaveProperty("announcedStatus");
  });
});
