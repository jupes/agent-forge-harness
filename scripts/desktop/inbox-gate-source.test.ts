import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  type InboxGateProjectionInput,
  projectInboxGateSource,
} from "../../apps/desktop/src/inbox-gate-source";
import type { ProjectRunDetail } from "../../types/project-runs";
import { projectRunDetailSchema } from "../projects/run-protocol";

const scope = {
  projectId: "project-015821b4-4b38-4bf3-9326-71ce9c09ff46",
  workspace: "/fixture/workspace",
};
const at = "2026-11-11T00:00:00.000Z";
function detail(): ProjectRunDetail {
  return projectRunDetailSchema.parse({
    version: 1,
    ...scope,
    checkout: "/fixture/checkout",
    asOf: at,
    coverage: "served-checkout-only",
    problems: [],
    run: {
      slug: "alpha-run",
      feature: "Alpha",
      epic: "alpha-epic",
      mode: "gated",
      health: "attention",
      phases: ["research", "plan", "implement", "ship"].map((id) => ({
        id,
        state: "locked",
        artifact: null,
        artifactMissing: false,
      })),
      status: { kind: "halted", phase: "implement", reason: "Gate failed" },
      completedCount: 0,
      totalPhases: 4,
      gatePassed: false,
      reviewRounds: 0,
      latestVerdict: null,
      updatedAt: at,
      complete: true,
    },
    reviews: [],
    gateHistory: [
      {
        event: "quality-gate",
        timestamp: at,
        passed: false,
        checks: [
          {
            name: "typecheck",
            passed: false,
            skipped: false,
            detail: "Failed",
          },
        ],
        checkout: "/fixture/checkout",
        branch: "feat/alpha",
        link: "linked",
        beadsIssueId: "alpha-task",
        executionRunId: "alpha-run",
        forgeSlug: null,
        evaluatorEvidence: "schema-2",
      },
    ],
    gateHistoryDays: 30,
    earlierGateLimit: 10,
  });
}
function input(raw: unknown = detail()): InboxGateProjectionInput {
  return {
    scope: { ...scope },
    runSlug: "alpha-run",
    expectedCheckout: "/fixture/checkout",
    sourceGeneration: 7,
    catalogRevision: 3,
    detail: {
      raw,
      lastVerified: null,
      coverage: {
        started: true,
        settled: true,
        complete: true,
        fresh: true,
        error: null,
      },
    },
  };
}
test("a strict scoped current failed gate produces one unresolved source fact", async () => {
  const result = await projectInboxGateSource(input());
  expect(result.facts).toHaveLength(1);
  expect(result.facts[0]).toMatchObject({
    ...scope,
    sourceKind: "failed-gate",
    status: "pending",
    fresh: true,
    complete: true,
    resolved: false,
    sourceIdentity: { runSlug: "alpha-run", gate: detail().gateHistory[0] },
  });
  expect(result.facts[0]?.unresolvedReason).toBeTruthy();
  expect(result.coverage).toMatchObject({ complete: true, fresh: true });
  expect(result.diagnostics).toEqual([]);
});

test("canonical identity uses full scope and source evidence, excluding titles, read times and epochs", async () => {
  const first = (await projectInboxGateSource(input())).facts[0];
  const tuple = [
    "inbox-source-v1",
    scope.workspace,
    scope.projectId,
    "failed-gate",
    [
      "gate",
      "alpha-run",
      "quality-gate",
      at,
      "/fixture/checkout",
      "linked",
      "alpha-task",
      "alpha-run",
      null,
    ],
  ];
  const hash = (value: unknown) =>
    `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
  expect(first?.stableItemId).toBe(hash(tuple));
  expect(first?.sourceRevision).toBe(
    hash([
      "inbox-revision-v1",
      tuple,
      [
        false,
        "feat/alpha",
        "schema-2",
        [["typecheck", false, false, "Failed"]],
      ],
    ]),
  );
  const changed = detail();
  changed.run.feature = "Renamed";
  changed.asOf = "2026-11-11T01:00:00.000Z";
  const next = input(changed);
  next.sourceGeneration++;
  next.catalogRevision++;
  const observed = (await projectInboxGateSource(next)).facts[0];
  expect(observed?.stableItemId).toBe(first?.stableItemId);
  expect(observed?.sourceRevision).toBe(first?.sourceRevision);
  changed.gateHistory[0]!.checks[0]!.detail = "Changed evidence";
  const revised = (await projectInboxGateSource(input(changed))).facts[0];
  expect(revised?.stableItemId).toBe(first?.stableItemId);
  expect(revised?.sourceRevision).not.toBe(first?.sourceRevision);
});

test("a current pass or verified empty history never resurfaces an older failure or resolves an original", async () => {
  const page = detail(),
    older = structuredClone(page.gateHistory[0]!);
  older.timestamp = "2026-11-10T23:00:00.000Z";
  page.gateHistory.push(older);
  page.gateHistory[0]!.passed = true;
  page.gateHistory[0]!.checks[0]!.passed = true;
  page.run.gatePassed = true;
  const passed = await projectInboxGateSource(input(page));
  expect(passed.facts).toEqual([]);
  expect(passed.coverage).toMatchObject({ complete: true, fresh: true });
  page.gateHistory = [];
  page.run.gatePassed = null;
  const absent = await projectInboxGateSource(input(page));
  expect(absent.facts).toEqual([]);
  expect(absent.diagnostics).toEqual([]);
  expect(Object.keys(absent)).not.toContain("resolved");
});

test("wrong project, workspace, run or served checkout cannot project another scope", async () => {
  for (const patch of [
    {
      scope: {
        ...scope,
        projectId: "project-f05a117f-8d19-4906-80f0-75d72835f3e8",
      },
    },
    { scope: { ...scope, workspace: "/foreign" } },
    { runSlug: "foreign-run" },
    { expectedCheckout: "/foreign" },
  ]) {
    const result = await projectInboxGateSource({ ...input(), ...patch });
    expect(result.facts).toEqual([]);
    expect(result.coverage).toMatchObject({ complete: false, fresh: false });
    expect(result.diagnostics).not.toEqual([]);
  }
});

test("contradictory head, disordered times and duplicate identities retain only a coherent prior snapshot", async () => {
  for (const corrupt of [
    (page: ProjectRunDetail) => {
      page.run.gatePassed = true;
    },
    (page: ProjectRunDetail) => {
      const newer = structuredClone(page.gateHistory[0]!);
      newer.timestamp = "2026-11-11T02:00:00.000Z";
      page.gateHistory.push(newer);
    },
    (page: ProjectRunDetail) => {
      const duplicate = structuredClone(page.gateHistory[0]!);
      duplicate.checks[0]!.detail = "Contradictory duplicate";
      page.gateHistory.push(duplicate);
    },
  ]) {
    const raw = detail();
    corrupt(raw);
    const candidate = input(raw);
    candidate.detail.lastVerified = detail();
    const result = await projectInboxGateSource(candidate);
    expect(result.facts).toHaveLength(1);
    expect(result.facts[0]).toMatchObject({
      fresh: false,
      complete: false,
      resolved: false,
      sourceIdentity: { gate: detail().gateHistory[0] },
    });
    expect(result.coverage.complete).toBe(false);
  }
});

test("retained DTOs are independently verified and unavailable coverage is never verified empty", async () => {
  for (const prior of [
    null,
    { ...detail(), workspace: "/foreign" },
    { ...detail(), problems: ["Incomplete"] },
  ]) {
    const candidate = input({ malformed: true });
    candidate.detail.lastVerified = prior;
    const result = await projectInboxGateSource(candidate);
    expect(result.facts).toEqual([]);
    expect(result.coverage).toMatchObject({ complete: false, fresh: false });
    expect(result.diagnostics).toHaveLength(1);
  }
});

test("coverage gaps require verified prior facts; invalid epochs cannot supply provenance", async () => {
  for (const patch of [
    { started: false },
    { settled: false },
    { complete: false },
    { fresh: false },
    { error: "Read unavailable" },
  ]) {
    const candidate = input();
    candidate.detail.coverage = { ...candidate.detail.coverage, ...patch };
    const unavailable = await projectInboxGateSource(candidate);
    expect(unavailable.facts).toEqual([]);
    expect(unavailable.coverage.complete).toBe(false);
    candidate.detail.lastVerified = detail();
    const result = await projectInboxGateSource(candidate);
    expect(result.facts[0]).toMatchObject({
      fresh: false,
      complete: false,
      resolved: false,
    });
    expect(result.coverage.complete).toBe(false);
  }
  const invalid = input();
  invalid.sourceGeneration = Number.MAX_SAFE_INTEGER + 1;
  expect((await projectInboxGateSource(invalid)).facts).toEqual([]);
});

test("nested current and retained inputs, scope and provenance are captured before digest awaits", async () => {
  for (const retained of [false, true]) {
    const page = detail(),
      candidate = input(retained ? null : page);
    if (retained) candidate.detail.lastVerified = page;
    const pending = projectInboxGateSource(candidate);
    page.gateHistory[0]!.checks[0]!.detail = "Mutated during await";
    page.run.feature = "Mutated";
    candidate.scope.workspace = "/foreign";
    candidate.sourceGeneration = 99;
    candidate.catalogRevision = 99;
    candidate.runSlug = "foreign-run";
    candidate.expectedCheckout = "/foreign";
    candidate.detail.coverage.error = "Mutated";
    const result = await pending;
    expect(result).toMatchObject({
      scope,
      runSlug: "alpha-run",
      expectedCheckout: "/fixture/checkout",
      sourceGeneration: 7,
      catalogRevision: 3,
    });
    expect(result.facts[0]).toMatchObject({
      title: "Gate failed for Alpha",
      fresh: !retained,
      sourceIdentity: { gate: { checks: [{ detail: "Failed" }] } },
    });
    expect(Object.isFrozen(result.facts)).toBe(true);
    expect(
      Object.isFrozen(result.facts[0]?.sourceIdentity.gate.checks[0]),
    ).toBe(true);
  }
});

test("accepted Windows checkout spellings share identity while legacy evidence retains its label", async () => {
  const page = detail();
  page.checkout = "C:\\Fixture\\Checkout\\";
  page.gateHistory[0]!.checkout = "c:/fixture/checkout";
  const candidate = input(page);
  candidate.expectedCheckout = "c:/fixture/checkout";
  const first = (await projectInboxGateSource(candidate)).facts[0];
  page.checkout = "c:/fixture/checkout";
  page.gateHistory[0]!.checkout = "C:/FIXTURE/CHECKOUT/";
  const second = (await projectInboxGateSource(candidate)).facts[0];
  expect(second?.stableItemId).toBe(first?.stableItemId);
  expect(second?.sourceRevision).toBe(first?.sourceRevision);
  const gate = page.gateHistory[0]!;
  gate.link = "legacy";
  gate.forgeSlug = "alpha-run";
  gate.executionRunId = null;
  gate.beadsIssueId = null;
  gate.evaluatorEvidence = "legacy";
  const legacy = (await projectInboxGateSource(candidate)).facts[0];
  expect(legacy).toMatchObject({
    resolved: false,
    sourceIdentity: {
      gate: {
        link: "legacy",
        evaluatorEvidence: "legacy",
        beadsIssueId: null,
      },
    },
  });
  expect(Object.keys(legacy ?? {})).not.toContain("action");
});

test("unshipped gates support current and retained facts", async () => {
  const page = detail();
  page.run.complete = false;
  const current = await projectInboxGateSource(input(page));
  expect(current.facts).toHaveLength(1);
  expect(current.coverage.complete).toBe(true);
  const candidate = input({ malformed: true });
  candidate.detail.lastVerified = page;
  const retained = await projectInboxGateSource(candidate);
  expect(retained.facts).toHaveLength(1);
  expect(retained.facts[0]).toMatchObject({
    fresh: false,
    complete: false,
    resolved: false,
  });
  expect(retained.coverage.complete).toBe(false);
  expect(retained.facts[0]?.stableItemId).toBe(current.facts[0]?.stableItemId);
});
