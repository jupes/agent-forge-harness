import { describe, expect, test } from "bun:test";
import {
  forgeRunSnapshot,
  parseWorktreeState,
  phaseRows,
} from "../../scripts/dashboard/forge-run-model";
import type { ForgePhase } from "../../scripts/forge/phases";

const STATE = {
  slug: "agent-forge-harness-dg40",
  phase: "implement" as ForgePhase,
  completed: ["research", "plan"] as ForgePhase[],
  artifacts: {
    research: "plans/research/agent-forge-harness-dg40.md",
    plan: "plans/drafts/agent-forge-harness-dg40.md",
  },
  epic: "agent-forge-harness-dg40",
  feature: "Adopt the Nocturne design system",
  updatedAt: "2026-09-10T12:00:00.000Z",
};

describe("phaseRows", () => {
  test("marks completed, active and locked phases in pipeline order", () => {
    const rows = phaseRows(STATE);
    expect(rows.map((row) => row.id)).toEqual([
      "research",
      "plan",
      "implement",
      "ship",
    ]);
    expect(rows.map((row) => row.state)).toEqual([
      "complete",
      "complete",
      "active",
      "locked",
    ]);
  });

  test("names the artifact each phase produces", () => {
    const rows = phaseRows(STATE);
    expect(rows[0]?.artifact).toBe(
      "plans/research/agent-forge-harness-dg40.md",
    );
    expect(rows[3]?.artifact).toBe("reports/agent-forge-harness-dg40-ship.md");
  });

  test("treats a finished run as all-complete rather than leaving ship active", () => {
    const rows = phaseRows({
      ...STATE,
      phase: "ship",
      completed: ["research", "plan", "implement", "ship"] as ForgePhase[],
    });
    expect(rows.every((row) => row.state === "complete")).toBe(true);
  });

  test("returns the pipeline with everything locked when no run exists", () => {
    const rows = phaseRows(null);
    expect(rows).toHaveLength(4);
    expect(rows.every((row) => row.state === "locked")).toBe(true);
  });
});

describe("parseWorktreeState", () => {
  test("reads the worktree records the harness writes", () => {
    const parsed = parseWorktreeState(
      JSON.stringify({
        worktrees: [
          {
            id: "dg40",
            path: "C:/repo/trees/dg40",
            branch: "feat/nocturne",
            createdAt: "2026-09-09T22:00:00.000Z",
          },
        ],
      }),
    );
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.branch).toBe("feat/nocturne");
  });

  test("returns nothing rather than throwing on malformed or absent state", () => {
    expect(parseWorktreeState("")).toEqual([]);
    expect(parseWorktreeState("not json")).toEqual([]);
    expect(parseWorktreeState("{}")).toEqual([]);
    expect(parseWorktreeState(JSON.stringify({ worktrees: "no" }))).toEqual([]);
  });

  test("skips records missing the fields the view renders", () => {
    const parsed = parseWorktreeState(
      JSON.stringify({
        worktrees: [
          { id: "x" },
          { branch: "b", path: "p", id: "y", createdAt: "t" },
        ],
      }),
    );
    expect(parsed.map((w) => w.id)).toEqual(["y"]);
  });
});

describe("forgeRunSnapshot", () => {
  test("reports the run, its phases and worktrees together", () => {
    const snapshot = forgeRunSnapshot({
      stateJson: JSON.stringify(STATE),
      worktreeJson: JSON.stringify({ worktrees: [] }),
      artifactExists: () => true,
    });
    expect(snapshot.slug).toBe("agent-forge-harness-dg40");
    expect(snapshot.epic).toBe("agent-forge-harness-dg40");
    expect(snapshot.phases).toHaveLength(4);
    expect(snapshot.worktrees).toEqual([]);
  });

  test("says so plainly when no forge run is in flight", () => {
    const snapshot = forgeRunSnapshot({
      stateJson: null,
      worktreeJson: null,
      artifactExists: () => false,
    });
    expect(snapshot.slug).toBeNull();
    expect(snapshot.phases.every((p) => p.state === "locked")).toBe(true);
  });

  test("flags an artifact a phase claims but that is missing on disk", () => {
    const snapshot = forgeRunSnapshot({
      stateJson: JSON.stringify(STATE),
      worktreeJson: null,
      artifactExists: (path) => !path.includes("research"),
    });
    const research = snapshot.phases.find((p) => p.id === "research");
    expect(research?.artifactMissing).toBe(true);
    const plan = snapshot.phases.find((p) => p.id === "plan");
    expect(plan?.artifactMissing).toBe(false);
  });
});
