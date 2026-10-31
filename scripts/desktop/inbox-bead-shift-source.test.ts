import { expect, test } from "bun:test";
import { projectBeadsPageSchema } from "../projects/beads-protocol";
import { projectWorkbenchPageSchema } from "../projects/workbench-protocol";
import { projectShiftsPageSchema } from "../shifts/protocol";
import type { ProjectBeadsPage } from "../../types/project-beads";
import type { ProjectShiftsPage, ProjectShiftReceipt } from "../../types/project-shifts";
import type { ProjectWorkbenchPage } from "../../types/project-workbench";
import { projectShiftInputHash } from "../../apps/desktop/src/project-shift-identities";
import { verifyProjectShiftReceipt } from "../../apps/desktop/src/project-shift-receipt";
import {
  projectInboxBeadShiftSources,
  type InboxSourceRead,
} from "../../apps/desktop/src/inbox-bead-shift-source";

const scope = {
    projectId: "project-a5832fa0-7a21-403b-8184-44892f0d8d86",
    workspace: "/fixture/workspace",
  },
  asOf = "2026-10-31T12:00:00.000Z",
  beadId = "alpha-task",
  shiftId = "shift-20261031-120000-1234",
  requestId = "2230bb02-1119-4c69-adad-c44116b375c1";

function workbench(): ProjectWorkbenchPage {
  return projectWorkbenchPageSchema.parse({
    projectId: scope.projectId,
    workspace: scope.workspace,
    asOf,
    complete: true,
    problems: [],
    cards: [
      {
        entry: {
          beadId,
          title: "Approve alpha task",
          state: "proposed",
          status: "open",
          backed: true,
        },
        moves: ["approve", "pause"],
        complexity: null,
        smith: { name: null, via: null, reason: null },
        updatedAt: asOf,
        note: null,
        eligibility: null,
        session: null,
      },
    ],
    smiths: null,
    host: null,
  });
}

function beads(): ProjectBeadsPage {
  return projectBeadsPageSchema.parse({
    projectId: scope.projectId,
    workspace: scope.workspace,
    asOf,
    complete: true,
    problems: [],
    beads: [
      {
        id: beadId,
        title: "Approve alpha task",
        type: "task",
        status: "open",
        priority: 2,
        parent: null,
        assignee: null,
        owner: null,
        labels: [],
        createdAt: asOf,
        updatedAt: asOf,
        due: null,
        description: "",
        acceptanceCriteria: "",
        estimate: null,
        spent: null,
        ready: false,
        blocked: false,
        blockers: [],
        unavailableBlockers: 0,
        queue: "proposed",
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

async function shifts(): Promise<ProjectShiftsPage> {
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
        ...scope,
        shiftId,
        request,
        requestHash: await projectShiftInputHash(scope, request),
        createdAt: asOf,
        attemptedAt: asOf,
      },
      observation: {
        shiftId,
        requestId,
        phase: "needs-recovery",
        reason: "Original worker did not settle",
        actual: {
          startedAt: asOf,
          endedAt: null,
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
    projectId: scope.projectId,
    asOf,
    items: [receipt],
  });
}

const read = <T>(raw: T): InboxSourceRead<T> => ({
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
});
