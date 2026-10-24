import { expect, test } from "bun:test";
import {
  filterRuns,
  gateCheckRows,
  parseRunFilters,
  runStatus,
  runsHref,
} from "../../apps/desktop/src/project-runs-model";
import type { ProjectRunGate, ProjectRunRow } from "../../types/project-runs";

test("gate states distinguish actual skipped, failed, passed and absent checks and retain additional names", () => {
  const gate: ProjectRunGate = {
    event: "gate.ran",
    timestamp: "2026-10-23T12:00:00.000Z",
    passed: false,
    checks: [
      { name: "typecheck", passed: true, skipped: false, detail: null },
      {
        name: "lint",
        passed: false,
        skipped: false,
        detail: "Recorded lint failure",
      },
      { name: "tests", passed: true, skipped: true, detail: "Not requested" },
      { name: "native", passed: true, skipped: false, detail: null },
    ],
    checkout: "/checkout",
    branch: null,
    link: "linked",
    beadsIssueId: "alpha-epic",
    executionRunId: "alpha-run",
    forgeSlug: null,
    evaluatorEvidence: null,
  };
  expect(gateCheckRows(gate).map((row) => [row.name, row.state])).toEqual([
    ["typecheck", "Pass"],
    ["lint", "Fail"],
    ["tests", "Skipped"],
    ["clean-tree", "Not run"],
    ["eval-verdict", "Not run"],
    ["native", "Pass"],
  ]);
  expect(gateCheckRows(null).every((check) => check.state === "Not run")).toBe(
    true,
  );
});

test("run filtering and hash navigation preserve the run's real historical mode without inventing route or start facts", () => {
  const row: ProjectRunRow = {
    slug: "alpha-run",
    feature: "Scoped forge",
    epic: "alpha-epic",
    mode: "auto",
    health: "attention",
    status: { kind: "halted", phase: "plan", reason: "Review limit" },
    phases: [
      {
        id: "research",
        state: "complete",
        artifact: null,
        artifactMissing: false,
      },
      { id: "plan", state: "active", artifact: null, artifactMissing: false },
      {
        id: "implement",
        state: "locked",
        artifact: null,
        artifactMissing: false,
      },
      { id: "ship", state: "locked", artifact: null, artifactMissing: false },
    ],
    completedCount: 1,
    totalPhases: 4,
    gatePassed: null,
    reviewRounds: 0,
    latestVerdict: null,
    updatedAt: null,
    complete: false,
  };
  const filters = {
    search: "SCOPED",
    health: "attention",
    mode: "auto",
  } as const;
  expect(filterRuns([row], filters)).toEqual([row]);
  expect(filterRuns([row], { ...filters, mode: "gated" })).toEqual([]);
  const href = runsHref("project-alpha", "alpha-run", filters);
  expect(parseRunFilters(href)).toEqual({ filters, error: "" });
  expect(href).toContain("selectionKind=run");
  expect(runStatus(row)).toBe("Halted at Plan: Review limit");
  for (const query of [
    "?runMode=full",
    "?runHealth=unknown",
    "?runSearch=a&runSearch=b",
    "?checkout=foreign",
  ]) {
    expect(
      parseRunFilters(`#/desktop/project/p/runs${query}`).filters,
    ).toBeNull();
  }
});
