import { expect, test } from "bun:test";
import { join } from "node:path";
import { keeperShiftStartHashesInBrowser } from "../../apps/desktop/src/keeper-shift-hash";
import {
  acceptKeeperShiftReceipt,
  buildKeeperShiftStart,
  createKeeperShiftReview,
  editKeeperShiftDraft,
  holdKeeperShiftReview,
  initializeKeeperShiftReview,
  keeperShiftObservationPhase,
  keeperShiftReceiptStatus,
  prefillKeeperShiftDraft,
} from "../../apps/desktop/src/keeper-shift-review";
import type {
  KeeperProposal,
  KeeperProposalRecord,
} from "../../types/keeper-proposal";
import type {
  KeeperShiftStartReceipt,
  KeeperShiftStartRequest,
} from "../../types/keeper-shift-start";
import type {
  ProjectShiftOptions,
  ProjectShiftReceipt,
} from "../../types/project-shifts";
import {
  keeperShiftProposalMatches,
  keeperShiftStartHashes,
} from "../keeper/shift-start-protocol";

const projectId = "project-a5832fa0-7a21-403b-8184-44892f0d8d86";
const workspace = "C:/fixture/repository";
const requestId = "913c01ee-e854-4d0e-8d6c-a246304d74a1";
const source: KeeperProposal = {
  id: "proposal-1a5832fa-7a21-403b-8184-44892f0d8d86-0",
  projectId,
  sourceRequestId: "1a5832fa-7a21-403b-8184-44892f0d8d86",
  sourceHash: "a".repeat(64),
  createdAt: "2026-10-25T12:00:00.000Z",
  draft: {
    title: "Review a project Shift",
    detail: "Review the complete bounds before starting.",
    action: {
      kind: "start-shift",
      durationMinutes: 45,
      concurrency: 2,
      beadLimit: 5,
      spendLimitUsd: 8,
    },
  },
};

function shiftOptions(): ProjectShiftOptions {
  return {
    projectId,
    workspace,
    catalogRevision: 7,
    asOf: "2026-10-25T12:00:00.000Z",
    defaults: {
      for: { value: "20m", source: "project config" },
      concurrency: { value: 2, source: "project config" },
      maxBeads: { value: 5, source: "project config" },
      maxUsd: { value: 8, source: "project config" },
      repairs: { value: 2, source: "project config" },
      base: { value: "main", source: "project config" },
      runTimeout: { value: null, source: "Shift remaining time" },
    },
    limits: {
      durationMs: [60_000, 86_400_000],
      concurrency: [1, 8],
      maxBeads: [1, 100],
      maxUsd: 1000,
      repairs: [0, 8],
    },
    epics: [{ id: "alpha-epic", title: "Alpha" }],
    smiths: { names: ["claude-journeyman"], defaultSmith: null },
    availability: { start: true, reason: null },
  };
}

function readyReview() {
  return initializeKeeperShiftReview(
    createKeeperShiftReview(source, 4),
    shiftOptions(),
  );
}

function fullRequest(): KeeperShiftStartRequest {
  return {
    sourceHash: source.sourceHash,
    expectedRevision: 4,
    start: {
      requestId,
      expectedCatalogRevision: 7,
      options: {
        for: "90m",
        concurrency: 3,
        maxBeads: 8,
        maxUsd: 12,
        repairs: 3,
        base: "main",
        epic: "alpha-epic",
        smith: "claude-journeyman",
        runTimeout: "10m",
      },
    },
  };
}

function receiptFor(
  savedPhase: KeeperProposalRecord["phase"],
  observedPhase: ProjectShiftReceipt["observation"]["phase"] | null,
  actual: ProjectShiftReceipt["observation"]["actual"],
  startupStop = false,
): KeeperShiftStartReceipt {
  const original = fullRequest(),
    bounds = source.draft.action;
  if (bounds.kind !== "start-shift") throw Error("Wrong proposal fixture");
  const proposal = {
      durationMinutes: bounds.durationMinutes,
      concurrency: bounds.concurrency,
      beadLimit: bounds.beadLimit,
      spendLimitUsd: bounds.spendLimitUsd,
    },
    hashes = keeperShiftStartHashes(
      projectId,
      source.id,
      workspace,
      proposal,
      original,
    ),
    record: KeeperProposalRecord = {
      ...source,
      requestId,
      requestHash: hashes.reviewHash,
      operation: "approve",
      auditEventId: 17,
      phase: savedPhase,
      pending: false,
      updatedAt: source.createdAt,
      message: `Saved ${savedPhase} Shift review`,
      objects: [],
    };
  let shift: ProjectShiftReceipt | null = null;
  if (observedPhase !== null) {
    const attemptedAt = "2026-10-25T12:00:01.000Z";
    shift = {
      intent: {
        projectId,
        workspace,
        shiftId: "shift-20261025-120002-abcd",
        request: original.start,
        requestHash: hashes.startHash,
        createdAt: attemptedAt,
        attemptedAt,
        ...(startupStop
          ? {
              startupStop: {
                requestedAt: "2026-10-25T12:00:03.000Z",
                completedAt: "2026-10-25T12:00:04.000Z",
              },
            }
          : {}),
      },
      observation: {
        shiftId: "shift-20261025-120002-abcd",
        requestId,
        phase: observedPhase,
        reason: observedPhase === "failed" ? "startup failed" : null,
        actual,
      },
    };
  }
  return {
    projectId,
    proposalId: source.id,
    revision: 5,
    record,
    workspace,
    original,
    startHash: hashes.startHash,
    shift,
  };
}

function actualShift(): NonNullable<
  ProjectShiftReceipt["observation"]["actual"]
> {
  return {
    startedAt: "2026-10-25T12:00:02.000Z",
    endedAt: null,
    deadline: "2026-10-25T13:30:02.000Z",
    concurrency: 3,
    forMs: 5_400_000,
    maxBeads: 8,
    maxUsd: 12,
    repairs: 3,
    throttle: null,
    base: "main",
    epic: "alpha-epic",
    smith: "claude-journeyman",
    runTimeoutMs: 600_000,
    spentUsd: 0,
    unpriced: 0,
    admitted: 0,
    reviewed: 0,
    running: 0,
    halted: 0,
  };
}

test("proposal bounds prefill the complete canonical form while every default source remains available", () => {
  const options = shiftOptions(),
    draft = prefillKeeperShiftDraft(source, options);
  expect(draft).toEqual({
    expectedCatalogRevision: 7,
    for: "45m",
    concurrency: "2",
    maxBeads: "5",
    maxUsd: "8",
    repairs: "2",
    base: "main",
    epic: "",
    smith: "",
    runTimeout: "",
  });
  expect(options.defaults).toMatchObject({
    for: { source: "project config" },
    repairs: { source: "project config" },
    runTimeout: { value: null, source: "Shift remaining time" },
  });
});

test("a human-reviewed full request may edit the four proposal bounds and retains optional canonical fields", async () => {
  const review = readyReview();
  const edited = editKeeperShiftDraft(review, {
    for: "90m",
    concurrency: "3",
    maxBeads: "8",
    maxUsd: "12",
    repairs: "3",
    epic: "alpha-epic",
    smith: "claude-journeyman",
    runTimeout: "10m",
  });
  const built = await buildKeeperShiftStart(edited, requestId);
  expect(built.ok).toBe(true);
  if (!built.ok) throw Error(built.reason);
  expect(
    keeperShiftProposalMatches(
      source.draft.action.kind === "start-shift"
        ? {
            durationMinutes: source.draft.action.durationMinutes,
            concurrency: source.draft.action.concurrency,
            beadLimit: source.draft.action.beadLimit,
            spendLimitUsd: source.draft.action.spendLimitUsd,
          }
        : (() => {
            throw Error("Wrong proposal fixture");
          })(),
      built.request,
    ),
  ).toBe(false);
  expect(built.request).toEqual(fullRequest());
  expect(built.startHash).toMatch(/^[a-f0-9]{64}$/);
  expect(built.reviewHash).toMatch(/^[a-f0-9]{64}$/);
  expect(
    await keeperShiftStartHashesInBrowser(
      projectId,
      source.id,
      workspace,
      { durationMinutes: 45, concurrency: 2, beadLimit: 5, spendLimitUsd: 8 },
      built.request,
    ),
  ).toEqual({ startHash: built.startHash, reviewHash: built.reviewHash });
});

test("known UUIDs and missing originals stay held through edit and 404 without replacement", async () => {
  const held = initializeKeeperShiftReview(
      createKeeperShiftReview(source, 4),
      shiftOptions(),
      requestId,
    ),
    edited = editKeeperShiftDraft(held, { for: "2h" }),
    missing = holdKeeperShiftReview(
      edited,
      "No original is available for this held UUID. Check again; do not replace it.",
    );
  expect(held.status).toBe("held");
  expect(edited).toBe(held);
  expect(missing.requestId).toBe(requestId);
  expect(
    (
      await buildKeeperShiftStart(
        missing,
        "a13c01ee-e854-4d0e-8d6c-a246304d74a2",
      )
    ).ok,
  ).toBe(false);
});

test("protected original recovery restores the exact full request and refuses a tampered hash or foreign scope", async () => {
  const current = readyReview(),
    receipt = receiptFor("done", "running", actualShift()),
    restored = await acceptKeeperShiftReceipt(current, receipt);
  expect(restored.status).toBe("recorded");
  expect(restored.original).toEqual(receipt.original);
  expect(restored.draft?.epic).toBe("alpha-epic");
  expect(restored.draft?.runTimeout).toBe("10m");
  expect(keeperShiftObservationPhase(restored)).toBe("running");
  expect(restored.notice).toContain("canonical Shift record");
  expect(restored.notice).not.toContain("provider task completed");

  const tampered = structuredClone(receipt);
  tampered.original.start.options.maxBeads = 9;
  await expect(acceptKeeperShiftReceipt(current, tampered)).rejects.toThrow(
    "could not be verified",
  );
  const foreign = structuredClone(receipt);
  foreign.workspace = "C:/retargeted";
  await expect(acceptKeeperShiftReceipt(current, foreign)).rejects.toThrow();
});

test("admitted unknown and failed outcomes stay sticky across repeated done receipts and read holds", async () => {
  for (const phase of ["unknown", "failed"] as const) {
    const first = await acceptKeeperShiftReceipt(
        readyReview(),
        receiptFor(phase, null, null),
      ),
      held = holdKeeperShiftReview(first, "The protected read failed."),
      second = await acceptKeeperShiftReceipt(
        held,
        receiptFor("done", "running", actualShift()),
      ),
      third = await acceptKeeperShiftReceipt(
        second,
        receiptFor("done", "running", actualShift()),
      );
    expect(first.status).toBe(phase);
    expect(second.status).toBe(phase);
    expect(third.status).toBe(phase);
    expect(third.admittedOutcome).toBe(phase);
    expect(third.original).toEqual(first.original);
  }
});

test("an initially held review can recover its first verified receipt and a recorded outcome can downgrade", async () => {
  const held = initializeKeeperShiftReview(
      createKeeperShiftReview(source, 4),
      shiftOptions(),
      requestId,
    ),
    recovered = await acceptKeeperShiftReceipt(
      held,
      receiptFor("done", "running", actualShift()),
    ),
    downgraded = await acceptKeeperShiftReceipt(
      recovered,
      receiptFor("done", null, null),
    );
  expect(held.receipt).toBeNull();
  expect(recovered.status).toBe("recorded");
  expect(downgraded.status).toBe("unknown");
  expect(downgraded.admittedOutcome).toBe("unknown");
});

test("saved done may downgrade on weaker live evidence, while saved failed or unknown never upgrades", () => {
  expect(keeperShiftReceiptStatus(receiptFor("done", null, null))).toBe(
    "unknown",
  );
  expect(keeperShiftReceiptStatus(receiptFor("done", "failed", null))).toBe(
    "failed",
  );
  expect(
    keeperShiftReceiptStatus(receiptFor("done", "stopped", null, true)),
  ).toBe("failed");
  expect(
    keeperShiftReceiptStatus(receiptFor("unknown", "running", actualShift())),
  ).toBe("unknown");
  expect(
    keeperShiftReceiptStatus(receiptFor("failed", "running", actualShift())),
  ).toBe("failed");
});

test("only an explicit ready review can produce a valid request", async () => {
  const review = readyReview(),
    invalidId = await buildKeeperShiftStart(review, "not-a-uuid"),
    loading = createKeeperShiftReview(source, 4),
    disabled = initializeKeeperShiftReview(loading, {
      ...shiftOptions(),
      availability: { start: false, reason: "Project is archived." },
    });
  expect(invalidId.ok).toBe(false);
  expect(disabled.status).toBe("held");
  expect((await buildKeeperShiftStart(disabled, requestId)).ok).toBe(false);
  expect((await buildKeeperShiftStart(loading, requestId)).ok).toBe(false);
});

test("Keeper identity and review renderer entrypoints build without a Node crypto dependency", async () => {
  for (const entrypoint of [
    "../../apps/desktop/src/keeper-shift-identities.ts",
    "../../apps/desktop/src/keeper-shift-review.ts",
  ]) {
    const built = await Bun.build({
      entrypoints: [join(import.meta.dir, entrypoint)],
      target: "browser",
    });
    expect(built.success).toBe(true);
    const output = await built.outputs[0]?.text();
    expect(output).toBeDefined();
    for (const forbidden of ["node:crypto", 'from "crypto"', "createHash"])
      expect(output).not.toContain(forbidden);
  }
});
