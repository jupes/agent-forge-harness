import { describe, expect, test } from "bun:test";
import {
  comparableCheckout,
  forgeRunSnapshot,
  issueStatusFromBdShow,
  latestGateRun,
  phaseRows,
  REVIEW_NOTE_LIMIT,
  reviewCommentFor,
} from "../../scripts/dashboard/forge-run-model";
import type { ForgePhase } from "../../scripts/forge/phases";

const STATE = {
  slug: "agent-forge-harness-dg40",
  phase: "plan" as ForgePhase,
  completed: ["research", "plan"] as ForgePhase[],
  artifacts: {
    research: "plans/research/agent-forge-harness-dg40.md",
    plan: "plans/drafts/agent-forge-harness-dg40.md",
  },
  epic: "agent-forge-harness-dg40",
  feature: "Adopt the Nocturne design system",
  updatedAt: "2026-09-10T12:00:00.000Z",
};

const CHECKOUT = "C:/Users/dev/agent-forge-harness/trees/dg40";
const SCOPE = { checkout: CHECKOUT, slug: "agent-forge-harness-dg40" };

/** A line as `.claude/hooks/quality-gate.ts` appends it, identity included. */
function gateLine(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    event: "TaskCompleted",
    timestamp: "2026-09-10T12:00:00.000Z",
    checkout: CHECKOUT,
    branch: "feat/nocturne",
    taskId: "agent-forge-harness-dg40.9",
    forgeSlug: "agent-forge-harness-dg40",
    passed: false,
    checks: [
      { name: "typecheck", passed: true },
      {
        name: "lint",
        passed: false,
        output: "Found 2 errors.\ndocs/js/app.tsx:12 ...",
      },
      {
        name: "tests",
        passed: true,
        skipped: true,
        skipReason: "no test files",
      },
    ],
    blockingFailures: ["lint"],
    ...over,
  });
}

describe("phaseRows", () => {
  test("marks completed, active and locked phases in pipeline order", () => {
    const rows = phaseRows(STATE);
    expect(rows.map((row) => row.id)).toEqual([
      "research",
      "plan",
      "implement",
      "ship",
    ]);
    // state.phase says "plan" (the last finished phase); the work is in
    // implement, so that is what reads as active.
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

  test("a finished run is all-complete", () => {
    const rows = phaseRows({
      ...STATE,
      phase: "ship",
      completed: ["research", "plan", "implement", "ship"] as ForgePhase[],
    });
    expect(rows.every((row) => row.state === "complete")).toBe(true);
  });

  test("with no run, every phase is locked", () => {
    const rows = phaseRows(null);
    expect(rows).toHaveLength(4);
    expect(rows.every((row) => row.state === "locked")).toBe(true);
  });
});

describe("latestGateRun", () => {
  test("reads a run's checks and identity from the hook's log format", () => {
    const run = latestGateRun([gateLine()], SCOPE);
    expect(run).toMatchObject({
      event: "TaskCompleted",
      passed: false,
      checkout: CHECKOUT,
      branch: "feat/nocturne",
      taskId: "agent-forge-harness-dg40.9",
      forgeSlug: "agent-forge-harness-dg40",
    });
    expect(run?.checks.map((check) => check.name)).toEqual([
      "typecheck",
      "lint",
      "tests",
    ]);
  });

  test("keeps the first line of failing output and the skip reason", () => {
    const run = latestGateRun([gateLine()], SCOPE);
    const lint = run?.checks.find((check) => check.name === "lint");
    const tests = run?.checks.find((check) => check.name === "tests");
    expect(lint).toMatchObject({ passed: false, detail: "Found 2 errors." });
    expect(tests).toMatchObject({ skipped: true, detail: "no test files" });
  });

  test("a newer run from another worktree is not this run's gate", () => {
    const mine = gateLine({ timestamp: "mine", passed: true });
    const theirs = gateLine({
      timestamp: "theirs",
      checkout: "C:/Users/dev/agent-forge-harness/trees/other",
    });
    expect(latestGateRun([`${mine}\n${theirs}`], SCOPE)?.timestamp).toBe(
      "mine",
    );
  });

  test("a run from this checkout but an earlier forge run is not shown", () => {
    const earlier = gateLine({ forgeSlug: "previous-run" });
    expect(latestGateRun([earlier], SCOPE)).toBeNull();
  });

  test("entries logged without identity are never attributed to a run", () => {
    const legacy = JSON.stringify({
      event: "TaskCompleted",
      timestamp: "t",
      passed: true,
      checks: [],
    });
    expect(latestGateRun([legacy], SCOPE)).toBeNull();
    expect(latestGateRun([legacy], { checkout: CHECKOUT, slug: null })).toBe(
      null,
    );
  });

  test("with no forge run in flight, only runs logged outside one match", () => {
    const scope = { checkout: CHECKOUT, slug: null };
    expect(latestGateRun([gateLine()], scope)).toBeNull();
    expect(latestGateRun([gateLine({ forgeSlug: null })], scope)).not.toBe(
      null,
    );
  });

  test("searches older logs, newest first, until a run matches", () => {
    const newest = gateLine({ checkout: "D:/elsewhere" });
    const older = gateLine({ timestamp: "older" });
    expect(latestGateRun([newest, null, older], SCOPE)?.timestamp).toBe(
      "older",
    );
  });

  test("stops reading logs at the first match", () => {
    let readAfterMatch = false;
    function* logs() {
      yield gateLine({ timestamp: "hit" });
      readAfterMatch = true;
      yield gateLine();
    }
    expect(latestGateRun(logs(), SCOPE)?.timestamp).toBe("hit");
    expect(readAfterMatch).toBe(false);
  });

  test("skips a trailing partial or malformed line", () => {
    const run = latestGateRun([`${gateLine()}\n{"event":"Task`], SCOPE);
    expect(run?.checks).toHaveLength(3);
  });

  test("truncates very long output rather than shipping it whole", () => {
    const run = latestGateRun(
      [
        gateLine({
          checks: [{ name: "x", passed: false, output: "e".repeat(900) }],
        }),
      ],
      SCOPE,
    );
    expect((run?.checks[0]?.detail ?? "").length).toBeLessThanOrEqual(200);
  });
});

describe("comparableCheckout", () => {
  test("treats git's and Node's spellings of a Windows path as one checkout", () => {
    expect(comparableCheckout("C:/Users/Dev/harness")).toBe(
      comparableCheckout("c:\\users\\dev\\harness\\"),
    );
    const run = latestGateRun([gateLine()], {
      checkout: "c:\\Users\\DEV\\agent-forge-harness\\trees\\dg40\\",
      slug: SCOPE.slug,
    });
    expect(run).not.toBeNull();
  });

  test("keeps POSIX paths case-sensitive", () => {
    expect(comparableCheckout("/home/Dev/harness/")).toBe("/home/Dev/harness");
    expect(comparableCheckout("/home/dev/harness")).not.toBe(
      comparableCheckout("/home/Dev/harness"),
    );
  });
});

describe("forgeRunSnapshot", () => {
  test("reports the run, its phases, and the gate scoped to this checkout and run", () => {
    const snapshot = forgeRunSnapshot({
      stateJson: JSON.stringify(STATE),
      checkout: CHECKOUT,
      gateLogs: [gateLine()],
      artifactExists: () => true,
    });
    expect(snapshot.slug).toBe("agent-forge-harness-dg40");
    expect(snapshot.epic).toBe("agent-forge-harness-dg40");
    expect(snapshot.phases).toHaveLength(4);
    expect(snapshot.gateScope).toEqual(SCOPE);
    expect(snapshot.gate?.checks).toHaveLength(3);
  });

  test("says so plainly when no forge run is in flight", () => {
    const snapshot = forgeRunSnapshot({
      stateJson: null,
      checkout: CHECKOUT,
      gateLogs: [],
      artifactExists: () => false,
    });
    expect(snapshot.slug).toBeNull();
    expect(snapshot.gate).toBeNull();
    expect(snapshot.gateScope).toEqual({ checkout: CHECKOUT, slug: null });
    expect(snapshot.phases.every((p) => p.state === "locked")).toBe(true);
  });

  test("flags an artifact a phase claims but that is missing on disk", () => {
    const snapshot = forgeRunSnapshot({
      stateJson: JSON.stringify(STATE),
      checkout: CHECKOUT,
      gateLogs: [],
      artifactExists: (path) => !path.includes("research"),
    });
    expect(
      snapshot.phases.find((p) => p.id === "research")?.artifactMissing,
    ).toBe(true);
    expect(snapshot.phases.find((p) => p.id === "plan")?.artifactMissing).toBe(
      false,
    );
  });
});

describe("reviewCommentFor", () => {
  test("approval records a review: comment on the checkpoint", () => {
    expect(
      reviewCommentFor({
        issueId: "agent-forge-harness-j5k3",
        decision: "approve",
      }),
    ).toEqual({
      ok: true,
      issueId: "agent-forge-harness-j5k3",
      body: "review: checkpoint APPROVED via Forge run dashboard",
    });
  });

  test("an approval note is carried into the comment", () => {
    const result = reviewCommentFor({
      issueId: "agent-forge-harness-j5k3",
      decision: "approve",
      note: "  demo looked right  ",
    });
    expect(result).toMatchObject({
      ok: true,
      body: "review: checkpoint APPROVED via Forge run dashboard — demo looked right",
    });
  });

  test("requesting changes requires saying what to change", () => {
    expect(
      reviewCommentFor({ issueId: "a-1", decision: "request-changes" }).ok,
    ).toBe(false);
    expect(
      reviewCommentFor({
        issueId: "a-1",
        decision: "request-changes",
        note: "Split the table primitive",
      }),
    ).toMatchObject({
      ok: true,
      body: "review: CHANGES REQUESTED via Forge run dashboard — Split the table primitive",
    });
  });

  test("rejects ids that are not Beads ids, including ones bd could read as flags", () => {
    for (const issueId of ["", "--help", "-x", "a b", "a;rm", "$(x)", 42]) {
      expect(reviewCommentFor({ issueId, decision: "approve" }).ok).toBe(false);
    }
  });

  test("rejects unknown decisions and oversized notes", () => {
    expect(reviewCommentFor({ issueId: "a-1", decision: "close" }).ok).toBe(
      false,
    );
    expect(
      reviewCommentFor({
        issueId: "a-1",
        decision: "approve",
        note: "x".repeat(REVIEW_NOTE_LIMIT + 1),
      }).ok,
    ).toBe(false);
    expect(reviewCommentFor(null).ok).toBe(false);
  });
});

describe("issueStatusFromBdShow", () => {
  test("reads the status from bd show --json output", () => {
    expect(
      issueStatusFromBdShow(
        JSON.stringify([{ id: "a-1", status: "in_progress" }]),
      ),
    ).toBe("in_progress");
  });

  test("returns null for output it cannot read", () => {
    expect(issueStatusFromBdShow("")).toBeNull();
    expect(issueStatusFromBdShow("[]")).toBeNull();
    expect(issueStatusFromBdShow("Error: no issue found")).toBeNull();
  });
});
