import { describe, expect, test } from "bun:test";
import type { ForgeState } from "./phases";
import {
  activeRuns,
  byRecency,
  isValidSlug,
  legacyMigration,
  type RunSummary,
  runSlugFromFilename,
  runStatePath,
  summarizeRun,
} from "./runs";

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
