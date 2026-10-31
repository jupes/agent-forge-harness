import { expect, test } from "bun:test";
import {
  type InboxBeadShiftProjection,
  type InboxSourceRead,
  projectInboxBeadShiftSources,
} from "../../apps/desktop/src/inbox-bead-shift-source";
import { projectShiftInputHash } from "../../apps/desktop/src/project-shift-identities";
import { verifyProjectShiftReceipt } from "../../apps/desktop/src/project-shift-receipt";
import type { ProjectBeadsPage } from "../../types/project-beads";
import type {
  ProjectShiftReceipt,
  ProjectShiftsPage,
} from "../../types/project-shifts";
import type { ProjectWorkbenchPage } from "../../types/project-workbench";
import { projectBeadsPageSchema } from "../projects/beads-protocol";
import { workspaceKey } from "../projects/scope";
import { projectWorkbenchPageSchema } from "../projects/workbench-protocol";
import { projectShiftsPageSchema } from "../shifts/protocol";

const scope = {
    projectId: "project-a5832fa0-7a21-403b-8184-44892f0d8d86",
    workspace: "/fixture/workspace",
  },
  asOf = "2026-10-31T12:00:00.000Z",
  beadId = "alpha-task",
  shiftId = "shift-20261031-120000-1234",
  requestId = "2230bb02-1119-4c69-adad-c44116b375c1";
const staleCoverage = {
  started: true,
  settled: false,
  complete: false,
  fresh: false,
  error: "refresh did not settle",
};

function workbench(
  state: "proposed" | "halted" = "proposed",
  updatedAt = asOf,
  title = "Approve alpha task",
  fixtureScope = scope,
): ProjectWorkbenchPage {
  return projectWorkbenchPageSchema.parse({
    projectId: fixtureScope.projectId,
    workspace: fixtureScope.workspace,
    asOf: updatedAt,
    complete: true,
    problems: [],
    cards: [
      {
        entry: {
          beadId,
          title,
          state,
          status: "open",
          backed: true,
        },
        moves: state === "proposed" ? ["approve", "pause"] : ["queue"],
        complexity: null,
        smith: { name: null, via: null, reason: null },
        updatedAt,
        note: null,
        eligibility: null,
        session: null,
      },
    ],
    smiths: null,
    host: null,
  });
}

function beads(
  queue: "proposed" | "halted" = "proposed",
  updatedAt = asOf,
  title = "Approve alpha task",
  fixtureScope = scope,
): ProjectBeadsPage {
  return projectBeadsPageSchema.parse({
    projectId: fixtureScope.projectId,
    workspace: fixtureScope.workspace,
    asOf,
    complete: true,
    problems: [],
    beads: [
      {
        id: beadId,
        title,
        type: "task",
        status: "open",
        priority: 2,
        parent: null,
        assignee: null,
        owner: null,
        labels: [],
        createdAt: asOf,
        updatedAt,
        due: null,
        description: "",
        acceptanceCriteria: "",
        estimate: null,
        spent: null,
        ready: false,
        blocked: false,
        blockers: [],
        unavailableBlockers: 0,
        queue,
        smith: null,
        comments: [],
        commentsComplete: true,
        detailsLoaded: true,
        fileMap: null,
        fileMapReason: null,
        reservations: null,
        activity: null,
        activityComplete: true,
      },
    ],
    dependencies: [],
  });
}

async function shifts(
  phase: "needs-recovery" | "stopped" = "needs-recovery",
  fixtureScope = scope,
): Promise<ProjectShiftsPage> {
  const request = {
      requestId,
      expectedCatalogRevision: 7,
      options: {
        for: "2h",
        concurrency: 2,
        maxBeads: 4,
        maxUsd: 10,
        repairs: 3,
        base: "master",
      },
    },
    receipt: ProjectShiftReceipt = {
      intent: {
        ...fixtureScope,
        shiftId,
        request,
        requestHash: await projectShiftInputHash(fixtureScope, request),
        createdAt: asOf,
        attemptedAt: asOf,
      },
      observation: {
        shiftId,
        requestId,
        phase,
        reason: "Original worker did not settle",
        actual: {
          startedAt: asOf,
          endedAt: phase === "stopped" ? "2026-10-31T12:00:01.000Z" : null,
          deadline: "2026-10-31T14:00:00.000Z",
          concurrency: 2,
          forMs: 7_200_000,
          maxBeads: 4,
          maxUsd: 10,
          repairs: 3,
          throttle: 0.85,
          base: "master",
          epic: null,
          smith: null,
          runTimeoutMs: null,
          spentUsd: 0,
          unpriced: 0,
          admitted: 0,
          reviewed: 0,
          running: 0,
          halted: 0,
        },
      },
    };
  return projectShiftsPageSchema.parse({
    projectId: fixtureScope.projectId,
    asOf,
    items: [receipt],
  });
}

const read = <T>(
  raw: T,
  lastVerified: T | null = null,
  coverage: InboxSourceRead<T>["coverage"] = {
    started: true,
    settled: true,
    complete: true,
    fresh: true,
    error: null,
  },
): InboxSourceRead<T> => ({
  raw,
  lastVerified,
  coverage,
});
const retainedRead = <T>(
  lastVerified: T,
  coverage: InboxSourceRead<T>["coverage"],
): InboxSourceRead<T> => ({ raw: null, lastVerified, coverage });
const invalidRead = <T>(raw: unknown): InboxSourceRead<T> => ({
  raw,
  lastVerified: null,
  coverage: {
    started: true,
    settled: true,
    complete: true,
    fresh: true,
    error: null,
  },
});

const projectFrom = (
  workbenchRead: InboxSourceRead<ProjectWorkbenchPage>,
  beadsRead: InboxSourceRead<ProjectBeadsPage>,
  shiftsRead: InboxSourceRead<ProjectShiftsPage>,
) =>
  projectInboxBeadShiftSources({
    scope,
    sourceGeneration: 3,
    catalogRevision: 7,
    workbench: workbenchRead,
    beads: beadsRead,
    shifts: shiftsRead,
  });
const projectFromScope = (
  inputScope: typeof scope,
  workbenchRead: InboxSourceRead<ProjectWorkbenchPage>,
  beadsRead: InboxSourceRead<ProjectBeadsPage>,
  shiftsRead: InboxSourceRead<ProjectShiftsPage>,
) =>
  projectInboxBeadShiftSources({
    scope: inputScope,
    sourceGeneration: 3,
    catalogRevision: 7,
    workbench: workbenchRead,
    beads: beadsRead,
    shifts: shiftsRead,
  });

async function expectedDigest(value: unknown) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(value)),
  );
  return `sha256:${[...new Uint8Array(digest)]
    .map((part) => part.toString(16).padStart(2, "0"))
    .join("")}`;
}

test("projectInboxBeadShiftSources projects a backed approval and exact needs-recovery original", async () => {
  const workbenchPage = workbench(),
    beadsPage = beads(),
    shiftsPage = await shifts(),
    original = shiftsPage.items[0];
  expect(original).toBeDefined();
  if (!original) throw Error("Missing strict shift fixture");
  expect(workbenchPage.projectId).toBe(scope.projectId);
  expect(workbenchPage.workspace).toBe(scope.workspace);
  expect(beadsPage.projectId).toBe(scope.projectId);
  expect(beadsPage.workspace).toBe(scope.workspace);
  expect(
    await verifyProjectShiftReceipt(scope, original, {
      requestId,
      requestHash: original.intent.requestHash,
      shiftId,
    }),
  ).toEqual(original);

  const projected = await projectInboxBeadShiftSources({
    scope,
    sourceGeneration: 3,
    catalogRevision: 7,
    workbench: read(workbenchPage),
    beads: read(beadsPage),
    shifts: read(shiftsPage),
  });

  expect(projected.facts).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        sourceKind: "bead-approval",
        status: "pending",
        sourceIdentity: expect.objectContaining({
          beadId,
          queueState: "proposed",
          backed: true,
          allowedMoves: ["approve", "pause"],
        }),
        resolved: false,
        unresolvedReason: expect.any(String),
      }),
      expect.objectContaining({
        sourceKind: "stopped-shift",
        status: "pending",
        sourceIdentity: expect.objectContaining({
          shiftId,
          requestId,
          recomputedRequestHash: original.intent.requestHash,
          phase: "needs-recovery",
        }),
        resolved: false,
        unresolvedReason: expect.any(String),
      }),
    ]),
  );
  for (const fact of projected.facts) {
    expect(fact.stableItemId).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(fact.sourceRevision).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(fact.resolved).toBe(false);
    expect(fact.unresolvedReason.length).toBeGreaterThan(0);
  }
  const approval = projected.facts.find(
      (fact) => fact.sourceKind === "bead-approval",
    ),
    shiftFact = projected.facts.find(
      (fact) => fact.sourceKind === "stopped-shift",
    ),
    beadTuple = [
      "inbox-source-v1",
      workspaceKey(scope.workspace),
      scope.projectId,
      "bead-approval",
      ["bead", beadId],
    ],
    shiftTuple = [
      "inbox-source-v1",
      workspaceKey(scope.workspace),
      scope.projectId,
      "stopped-shift",
      ["shift", shiftId, requestId],
    ];
  expect(approval?.stableItemId).toBe(await expectedDigest(beadTuple));
  expect(approval?.sourceRevision).toBe(
    await expectedDigest([
      "inbox-revision-v1",
      beadTuple,
      [
        "bead-version-v1",
        asOf,
        "open",
        "proposed",
        "proposed",
        "open",
        "true",
        "approve",
        "pause",
      ],
    ]),
  );
  expect(shiftFact?.stableItemId).toBe(await expectedDigest(shiftTuple));
  expect(shiftFact?.sourceRevision).toBe(
    await expectedDigest([
      "inbox-revision-v1",
      shiftTuple,
      [
        "shift-version-v1",
        original.intent.requestHash,
        "needs-recovery",
        "Original worker did not settle",
      ],
    ]),
  );
});

test("halted beads stay pending while stopped shifts remain informational and revisions are source-derived", async () => {
  const base = await projectFrom(
      read(workbench()),
      read(beads()),
      read(await shifts()),
    ),
    halted = await projectFrom(
      read(workbench("halted")),
      read(beads("halted")),
      read(await shifts()),
    ),
    haltedFact = halted.facts.find((fact) => fact.sourceKind === "halted-bead");
  expect(haltedFact).toMatchObject({
    sourceKind: "halted-bead",
    status: "pending",
    sourceIdentity: { beadId, queueState: "halted", backed: true },
    resolved: false,
  });
  if (!haltedFact || haltedFact.sourceKind !== "halted-bead")
    throw Error("Missing halted source fact");
  expect(haltedFact.sourceIdentity.allowedMoves).toEqual(["queue"]);

  const stopped = await projectFrom(
      read(workbench()),
      read(beads()),
      read(await shifts("stopped")),
    ),
    stoppedFact = stopped.facts.find(
      (fact) =>
        fact.sourceKind === "stopped-shift" &&
        fact.sourceIdentity.phase === "stopped",
    );
  expect(stoppedFact).toMatchObject({
    sourceKind: "stopped-shift",
    status: "informational",
    resolved: false,
  });

  const renamed = await projectFrom(
      read(workbench("proposed", asOf, "Renamed title")),
      read(beads("proposed", asOf, "Renamed title")),
      read(await shifts()),
    ),
    renamedApproval = renamed.facts.find(
      (fact) => fact.sourceKind === "bead-approval",
    );
  expect(renamedApproval?.stableItemId).toBe(
    base.facts.find((fact) => fact.sourceKind === "bead-approval")
      ?.stableItemId,
  );
  expect(renamedApproval?.sourceRevision).toBe(
    base.facts.find((fact) => fact.sourceKind === "bead-approval")
      ?.sourceRevision,
  );
  const revised = await projectFrom(
    read(workbench("proposed", "2026-10-31T12:00:02.000Z")),
    read(beads("proposed", "2026-10-31T12:00:02.000Z")),
    read(await shifts()),
  );
  const revisedApproval = revised.facts.find(
    (fact) => fact.sourceKind === "bead-approval",
  );
  expect(revisedApproval?.stableItemId).toBe(renamedApproval?.stableItemId);
  expect(revisedApproval?.sourceRevision).not.toBe(
    renamedApproval?.sourceRevision,
  );
});

test("partial reads retain verified originals stale without action authority or resolution", async () => {
  const oldWorkbench = workbench(),
    oldBeads = beads(),
    oldShifts = await shifts(),
    projected = await projectFrom(
      retainedRead(oldWorkbench, staleCoverage),
      retainedRead(oldBeads, staleCoverage),
      retainedRead(oldShifts, staleCoverage),
    );
  expect(projected.facts.map((fact) => fact.sourceKind).sort()).toEqual([
    "bead-approval",
    "stopped-shift",
  ]);
  expect(projected.facts.every((fact) => !fact.fresh && !fact.complete)).toBe(
    true,
  );
  expect(projected.facts.every((fact) => fact.resolved === false)).toBe(true);
  const retainedApproval = projected.facts.find(
    (fact) => fact.sourceKind === "bead-approval",
  );
  expect(retainedApproval).toBeDefined();
  if (!retainedApproval || retainedApproval.sourceKind !== "bead-approval")
    throw Error("Missing retained approval fact");
  expect(retainedApproval.sourceIdentity.allowedMoves).toEqual([]);
  expect(projected.coverage.workbench.fresh).toBe(false);
  expect(projected.coverage.beads.fresh).toBe(false);
  expect(projected.coverage.shifts.fresh).toBe(false);
});

test("incoherent current snapshots fall back atomically to the retained joined pair", async () => {
  const priorWorkbench = workbench(),
    priorBeads = beads(),
    prior = await projectFrom(
      read(priorWorkbench),
      read(priorBeads),
      read(await shifts()),
    ),
    priorApproval = prior.facts.find(
      (fact) => fact.sourceKind === "bead-approval",
    );
  expect(priorApproval).toBeDefined();
  if (!priorApproval) throw Error("Missing prior approval fixture");

  const workbenchR2 = workbench("proposed", "2026-10-31T12:00:02.000Z"),
    workbenchRefresh = await projectFrom(
      read(workbenchR2, priorWorkbench),
      read(priorBeads, priorBeads),
      read(await shifts()),
    ),
    beadsRefresh = await projectFrom(
      read(priorWorkbench, priorWorkbench),
      read(beads("proposed", "2026-10-31T12:00:02.000Z"), priorBeads),
      read(await shifts()),
    );
  for (const result of [workbenchRefresh, beadsRefresh]) {
    const retained = result.facts.find(
      (fact) => fact.sourceKind === "bead-approval",
    );
    expect(retained).toBeDefined();
    if (!retained || retained.sourceKind !== "bead-approval")
      throw Error("Expected the coherent prior approval to remain visible");
    expect(retained.sourceRevision).toBe(priorApproval.sourceRevision);
    expect(retained.fresh).toBe(false);
    expect(retained.complete).toBe(false);
    expect(retained.resolved).toBe(false);
    expect(retained.sourceIdentity.allowedMoves).toEqual([]);
    expect(result.coverage.workbench.complete).toBe(false);
    expect(result.coverage.beads.complete).toBe(false);
  }

  const missingBead = await projectFrom(
    read(priorWorkbench, priorWorkbench),
    read({ ...priorBeads, beads: [] }, priorBeads),
    read(await shifts()),
  );
  expect(
    missingBead.facts.find((fact) => fact.sourceKind === "bead-approval")
      ?.sourceRevision,
  ).toBe(priorApproval.sourceRevision);
  expect(missingBead.coverage.workbench.fresh).toBe(false);
  expect(missingBead.coverage.beads.fresh).toBe(false);
  const noPrior = await projectFrom(
    read(priorWorkbench),
    read({ ...priorBeads, beads: [] }),
    read(await shifts()),
  );
  expect(
    noPrior.facts.some((fact) => fact.sourceKind === "bead-approval"),
  ).toBe(false);
  expect(noPrior.coverage.workbench.complete).toBe(false);
  expect(noPrior.coverage.beads.complete).toBe(false);
});

test("failed or malformed refreshes never mix raw and retained source generations", async () => {
  const priorWorkbench = workbench(),
    priorBeads = beads(),
    currentWorkbench = workbench("proposed", "2026-10-31T12:00:02.000Z"),
    currentBeads = beads("proposed", "2026-10-31T12:00:02.000Z"),
    cases: [
      InboxSourceRead<ProjectWorkbenchPage>,
      InboxSourceRead<ProjectBeadsPage>,
    ][] = [
      [
        { raw: {}, lastVerified: priorWorkbench, coverage: staleCoverage },
        read(currentBeads, priorBeads),
      ],
      [
        read(currentWorkbench, priorWorkbench),
        { raw: {}, lastVerified: priorBeads, coverage: staleCoverage },
      ],
      [
        read(currentWorkbench, priorWorkbench, staleCoverage),
        read(currentBeads, priorBeads),
      ],
      [
        read(currentWorkbench, priorWorkbench),
        read(currentBeads, priorBeads, staleCoverage),
      ],
    ];
  for (const [workbenchRead, beadsRead] of cases) {
    const result = await projectFrom(
      workbenchRead,
      beadsRead,
      read(await shifts()),
    );
    const approval = result.facts.find(
      (fact) => fact.sourceKind === "bead-approval",
    );
    expect(approval).toBeDefined();
    if (!approval || approval.sourceKind !== "bead-approval")
      throw Error("Expected retained prior approval");
    expect(approval.sourceIdentity.updatedAt).toBe(asOf);
    expect(approval.fresh).toBe(false);
    expect(approval.sourceIdentity.allowedMoves).toEqual([]);
    expect(result.coverage.workbench.complete).toBe(false);
    expect(result.coverage.beads.complete).toBe(false);
  }
});

test("unbacked and proposed rows without legal approve are excluded without false incompleteness", async () => {
  const unbacked = structuredClone(workbench()),
    noApprove = structuredClone(workbench()),
    unbackedCard = unbacked.cards[0],
    noApproveCard = noApprove.cards[0];
  expect(unbackedCard).toBeDefined();
  expect(noApproveCard).toBeDefined();
  if (!unbackedCard || !noApproveCard) throw Error("Missing Workbench fixture");
  unbackedCard.entry.backed = false;
  noApproveCard.moves = ["pause"];
  for (const page of [unbacked, noApprove]) {
    const result = await projectFrom(
      read(page),
      read(beads()),
      read(await shifts()),
    );
    expect(
      result.facts.some((fact) => fact.sourceKind === "bead-approval"),
    ).toBe(false);
    expect(result.coverage.workbench.complete).toBe(true);
    expect(result.coverage.beads.complete).toBe(true);
  }
});

test("duplicate Beads IDs reject current coverage and retain prior joined rows stale", async () => {
  const priorWorkbench = workbench(),
    priorBeads = beads(),
    duplicateBeads = {
      ...priorBeads,
      beads: [...priorBeads.beads, ...priorBeads.beads],
    },
    result = await projectFrom(
      read(priorWorkbench, priorWorkbench),
      read(duplicateBeads, priorBeads),
      read(await shifts()),
    ),
    approval = result.facts.find((fact) => fact.sourceKind === "bead-approval");
  expect(approval).toBeDefined();
  if (!approval || approval.sourceKind !== "bead-approval")
    throw Error("Expected prior approval to survive duplicate current data");
  expect(approval.fresh).toBe(false);
  expect(approval.sourceIdentity.allowedMoves).toEqual([]);
  expect(result.coverage.workbench.fresh).toBe(false);
  expect(result.coverage.beads.fresh).toBe(false);
});

test("foreign scope, a false shift hash and duplicate Workbench rows fail closed", async () => {
  const foreignWorkbench = { ...workbench(), projectId: "project-foreign" },
    foreignScope = await projectFrom(
      read(foreignWorkbench),
      read(beads()),
      read(await shifts()),
    );
  expect(
    foreignScope.facts.some((fact) => fact.sourceKind === "bead-approval"),
  ).toBe(false);
  expect(foreignScope.coverage.workbench.fresh).toBe(false);

  const foreignBeads = { ...beads(), workspace: "/other/workspace" },
    foreignBeadScope = await projectFrom(
      read(workbench()),
      read(foreignBeads),
      read(await shifts()),
    );
  expect(
    foreignBeadScope.facts.some((fact) => fact.sourceKind === "bead-approval"),
  ).toBe(false);
  expect(foreignBeadScope.coverage.beads.fresh).toBe(false);

  const tamperedShift = structuredClone(await shifts()),
    receipt = tamperedShift.items[0];
  expect(receipt).toBeDefined();
  if (!receipt) throw Error("Missing shift fixture");
  receipt.intent.requestHash = "0".repeat(receipt.intent.requestHash.length);
  const badHash = await projectFrom(
    read(workbench()),
    read(beads()),
    read(tamperedShift),
  );
  expect(
    badHash.facts.some((fact) => fact.sourceKind === "stopped-shift"),
  ).toBe(false);
  expect(badHash.coverage.shifts.fresh).toBe(false);

  const foreignShift = structuredClone(await shifts()),
    foreignReceipt = foreignShift.items[0];
  expect(foreignReceipt).toBeDefined();
  if (!foreignReceipt) throw Error("Missing foreign shift fixture");
  foreignReceipt.intent.workspace = "/foreign/workspace";
  foreignReceipt.intent.requestHash = await projectShiftInputHash(
    { ...scope, workspace: foreignReceipt.intent.workspace },
    foreignReceipt.intent.request,
  );
  const wrongWorkspace = await projectFrom(
    read(workbench()),
    read(beads()),
    read(foreignShift),
  );
  expect(
    wrongWorkspace.facts.some((fact) => fact.sourceKind === "stopped-shift"),
  ).toBe(false);
  expect(wrongWorkspace.coverage.shifts.fresh).toBe(false);

  const currentWorkbench = workbench(),
    priorBeads = beads(),
    duplicateWorkbench = {
      ...currentWorkbench,
      cards: [...currentWorkbench.cards, ...currentWorkbench.cards],
    },
    duplicateFacts = await projectFrom(
      read(duplicateWorkbench, currentWorkbench),
      read(beads(), priorBeads),
      read(await shifts()),
    ),
    retainedApproval = duplicateFacts.facts.find(
      (fact) => fact.sourceKind === "bead-approval",
    );
  expect(retainedApproval).toBeDefined();
  if (!retainedApproval || retainedApproval.sourceKind !== "bead-approval")
    throw Error("Expected the prior unique approval to remain visible");
  expect(retainedApproval.fresh).toBe(false);
  expect(retainedApproval.sourceIdentity.allowedMoves).toEqual([]);
  expect(duplicateFacts.coverage.workbench.complete).toBe(false);
});

test("canonical item identity separates project and canonical workspace scope", async () => {
  const base = await projectFrom(
      read(workbench()),
      read(beads()),
      read(await shifts()),
    ),
    otherProject = {
      projectId: "project-b5832fa0-7a21-403b-8184-44892f0d8d86",
      workspace: scope.workspace,
    },
    otherWorkspace = {
      projectId: scope.projectId,
      workspace: "C:/another/workspace",
    },
    projectVariant = await projectFromScope(
      otherProject,
      read(workbench("proposed", asOf, "Approve alpha task", otherProject)),
      read(beads("proposed", asOf, "Approve alpha task", otherProject)),
      read(await shifts("needs-recovery", otherProject)),
    ),
    workspaceVariant = await projectFromScope(
      otherWorkspace,
      read(workbench("proposed", asOf, "Approve alpha task", otherWorkspace)),
      read(beads("proposed", asOf, "Approve alpha task", otherWorkspace)),
      read(await shifts("needs-recovery", otherWorkspace)),
    );
  const identity = (result: InboxBeadShiftProjection) =>
    result.facts.find((fact) => fact.sourceKind === "bead-approval")
      ?.stableItemId;
  expect(identity(projectVariant)).not.toBe(identity(base));
  expect(identity(workspaceVariant)).not.toBe(identity(base));
});

test("duplicate shift originals do not create actionable current facts", async () => {
  const page = await shifts(),
    duplicate = { ...page, items: [...page.items, ...page.items] },
    projected = await projectFrom(
      read(workbench()),
      read(beads()),
      read(duplicate),
    );
  expect(
    projected.facts.some((fact) => fact.sourceKind === "stopped-shift"),
  ).toBe(false);
  expect(projected.coverage.shifts.complete).toBe(false);
  expect(projected.coverage.shifts.fresh).toBe(false);
});

test("malformed current pages report unavailable coverage instead of empty success", async () => {
  const projected = await projectFrom(
    invalidRead<ProjectWorkbenchPage>({}),
    invalidRead<ProjectBeadsPage>({}),
    invalidRead<ProjectShiftsPage>({}),
  );
  expect(projected.facts).toEqual([]);
  expect(projected.coverage.workbench.complete).toBe(false);
  expect(projected.coverage.beads.complete).toBe(false);
  expect(projected.coverage.shifts.complete).toBe(false);
  expect(projected.diagnostics.length).toBeGreaterThan(0);
});

test("captures selected scope and nested current originals before asynchronous shift verification", async () => {
  const inputScope = { ...scope },
    currentWorkbench = workbench(),
    currentBeads = beads(),
    currentShifts = await shifts(),
    expected = await projectFrom(
      read(structuredClone(currentWorkbench)),
      read(structuredClone(currentBeads)),
      read(structuredClone(currentShifts)),
    ),
    workbenchRead = read(currentWorkbench),
    beadsRead = read(currentBeads),
    shiftsRead = read(currentShifts),
    pending = projectInboxBeadShiftSources({
      scope: inputScope,
      sourceGeneration: 3,
      catalogRevision: 7,
      workbench: workbenchRead,
      beads: beadsRead,
      shifts: shiftsRead,
    });
  const workbenchCard = currentWorkbench.cards[0],
    bead = currentBeads.beads[0],
    shift = currentShifts.items[0];
  expect(workbenchCard).toBeDefined();
  expect(bead).toBeDefined();
  expect(shift).toBeDefined();
  if (!workbenchCard || !bead || !shift)
    throw Error("Missing selected current page fixture");
  inputScope.workspace = "/foreign/workspace";
  workbenchRead.coverage.fresh = false;
  workbenchCard.entry.title = "Mutated current title";
  workbenchCard.moves = ["pause"];
  bead.updatedAt = "2026-10-31T12:00:04.000Z";
  shift.intent.requestHash = "0".repeat(shift.intent.requestHash.length);
  shift.observation.phase = "stopped";
  const projected = await pending;
  const expectedApproval = expected.facts.find(
      (fact) => fact.sourceKind === "bead-approval",
    ),
    actualApproval = projected.facts.find(
      (fact) => fact.sourceKind === "bead-approval",
    ),
    expectedShift = expected.facts.find(
      (fact) => fact.sourceKind === "stopped-shift",
    ),
    actualShift = projected.facts.find(
      (fact) => fact.sourceKind === "stopped-shift",
    );
  expect(projected.scope).toEqual(scope);
  expect(projected.coverage.workbench.fresh).toBe(true);
  expect(actualApproval?.sourceRevision).toBe(expectedApproval?.sourceRevision);
  expect(actualApproval?.fresh).toBe(true);
  expect(actualApproval?.title).toBe(expectedApproval?.title);
  if (
    actualApproval?.sourceKind !== "bead-approval" ||
    expectedApproval?.sourceKind !== "bead-approval"
  )
    throw Error("Missing selected approval facts");
  expect(actualApproval.sourceIdentity.allowedMoves).toEqual(
    expectedApproval.sourceIdentity.allowedMoves,
  );
  expect(actualShift?.sourceRevision).toBe(expectedShift?.sourceRevision);
  expect(actualShift?.sourceIdentity).toEqual(expectedShift?.sourceIdentity);
});

test("captures nested raw and retained originals before awaiting receipt verification", async () => {
  const previousWorkbench = workbench(),
    previousBeads = beads(),
    previousShifts = await shifts(),
    expected = await projectFrom(
      read(previousWorkbench),
      read(previousBeads),
      read(previousShifts),
    ),
    rawWorkbench = workbench("proposed", "2026-10-31T12:00:02.000Z"),
    rawBeads = beads("proposed", "2026-10-31T12:00:02.000Z"),
    rawShifts = await shifts(),
    workbenchRead = read(rawWorkbench, previousWorkbench, staleCoverage),
    beadsRead = read(rawBeads, previousBeads, staleCoverage),
    shiftsRead = read(rawShifts, previousShifts, staleCoverage),
    pending = projectFrom(workbenchRead, beadsRead, shiftsRead);
  const rawWorkbenchCard = rawWorkbench.cards[0],
    priorWorkbenchCard = previousWorkbench.cards[0],
    rawBead = rawBeads.beads[0],
    priorBead = previousBeads.beads[0],
    rawShift = rawShifts.items[0],
    priorShift = previousShifts.items[0];
  expect(rawWorkbenchCard).toBeDefined();
  expect(priorWorkbenchCard).toBeDefined();
  expect(rawBead).toBeDefined();
  expect(priorBead).toBeDefined();
  expect(rawShift).toBeDefined();
  expect(priorShift).toBeDefined();
  if (
    !rawWorkbenchCard ||
    !priorWorkbenchCard ||
    !rawBead ||
    !priorBead ||
    !rawShift ||
    !priorShift
  )
    throw Error("Missing nested mutation fixture");
  rawWorkbenchCard.updatedAt = "2026-10-31T12:00:04.000Z";
  priorWorkbenchCard.updatedAt = "2026-10-31T12:00:05.000Z";
  rawBead.updatedAt = "2026-10-31T12:00:04.000Z";
  priorBead.updatedAt = "2026-10-31T12:00:05.000Z";
  rawShift.intent.requestHash = "0".repeat(rawShift.intent.requestHash.length);
  priorShift.observation.phase = "stopped";
  const projected = await pending,
    priorApproval = expected.facts.find(
      (fact) => fact.sourceKind === "bead-approval",
    ),
    priorShiftFact = expected.facts.find(
      (fact) => fact.sourceKind === "stopped-shift",
    ),
    retainedApproval = projected.facts.find(
      (fact) => fact.sourceKind === "bead-approval",
    ),
    retainedShift = projected.facts.find(
      (fact) => fact.sourceKind === "stopped-shift",
    );
  expect(retainedApproval?.sourceRevision).toBe(priorApproval?.sourceRevision);
  expect(retainedApproval?.fresh).toBe(false);
  expect(retainedShift).toBeDefined();
  expect(priorShiftFact).toBeDefined();
  if (
    !retainedShift ||
    retainedShift.sourceKind !== "stopped-shift" ||
    !priorShiftFact ||
    priorShiftFact.sourceKind !== "stopped-shift"
  )
    throw Error("Missing retained exact shift facts");
  expect(retainedShift.sourceIdentity).toMatchObject({
    phase: "needs-recovery",
    recomputedRequestHash: priorShiftFact.sourceIdentity.recomputedRequestHash,
  });
  expect(retainedShift?.fresh).toBe(false);
  expect(retainedShift?.resolved).toBe(false);
});
