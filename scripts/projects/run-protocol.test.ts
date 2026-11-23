import { expect, test } from "bun:test";
import { projectRunDetailSchema, projectRunsPageSchema } from "./run-protocol";

const row = {
  slug: "alpha",
  feature: "Alpha",
  epic: "alpha-epic",
  mode: "gated",
  health: "running",
  phases: [
    {
      id: "research",
      state: "active",
      artifact: "plans/research/alpha.md",
      artifactMissing: false,
    },
    {
      id: "plan",
      state: "locked",
      artifact: "plans/drafts/alpha.md",
      artifactMissing: false,
    },
    {
      id: "implement",
      state: "locked",
      artifact: null,
      artifactMissing: false,
    },
    {
      id: "ship",
      state: "locked",
      artifact: "reports/alpha-ship.md",
      artifactMissing: false,
    },
  ],
  status: { kind: "phase", phase: "research" },
  completedCount: 0,
  totalPhases: 4,
  gatePassed: null,
  reviewRounds: 0,
  latestVerdict: null,
  updatedAt: "2026-10-23T12:00:00.000Z",
  complete: false,
};
const source = {
  version: 1,
  projectId: "project-a5832fa0-7a21-403b-8184-44892f0d8d86",
  workspace: "/checked/root",
  checkout: "/checked/root",
  asOf: "2026-10-23T12:00:00.000Z",
  coverage: "served-checkout-only",
  problems: [],
};
test("strict run wire accepts only explicit bounded source facts, unique slugs and canonical phase order", () => {
  const page = { ...source, runs: [row] };
  expect(projectRunsPageSchema.safeParse(page).success).toBe(true);
  for (const invalid of [
    { ...page, sourcePath: "/caller/path" },
    { ...page, runs: [row, row] },
    { ...page, runs: [{ ...row, route: "full" }] },
    { ...page, runs: [{ ...row, startedAt: source.asOf }] },
    { ...page, runs: [{ ...row, phases: [...row.phases].reverse() }] },
    { ...page, runs: [{ ...row, epic: null }] },
    { ...page, runs: [{ ...row, completedCount: 4 }] },
  ])
    expect(projectRunsPageSchema.safeParse(invalid).success).toBe(false);
});
test("detail history cannot borrow a foreign run/checkout, invent an unlinked assignment or hide missing review rounds", () => {
  const gate = {
    event: "TaskCompleted",
    timestamp: source.asOf,
    passed: true,
    checks: [],
    checkout: source.checkout,
    branch: "feature",
    link: "linked",
    beadsIssueId: "alpha-epic",
    executionRunId: "alpha",
    forgeSlug: null,
    evaluatorEvidence: null,
  };
  const detail = {
    ...source,
    run: row,
    reviews: [],
    gateHistory: [gate],
    gateHistoryDays: 30,
    earlierGateLimit: 10,
  };
  expect(projectRunDetailSchema.safeParse(detail).success).toBe(true);
  for (const invalid of [
    { ...detail, gateHistory: [{ ...gate, executionRunId: "foreign" }] },
    { ...detail, gateHistory: [{ ...gate, checkout: "/foreign" }] },
    {
      ...detail,
      gateHistory: [{ ...gate, link: "unlinked", executionRunId: null }],
    },
    { ...detail, run: { ...row, reviewRounds: 1 } },
    { ...detail, reviews: [{ rawPrivate: "unbounded" }] },
  ])
    expect(projectRunDetailSchema.safeParse(invalid).success).toBe(false);
});

test("the receiving contract refuses an otherwise shaped collection over its finite byte cap", () => {
  const runs = Array.from({ length: 128 }, (_, index) => ({
    ...row,
    slug: `alpha-${index}`,
    feature: "f".repeat(2048),
    phases: row.phases.map((item) => ({ ...item, artifact: "p".repeat(1024) })),
  }));
  expect(projectRunsPageSchema.safeParse({ ...source, runs }).success).toBe(
    false,
  );
});
