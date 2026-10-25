import { expect, test } from "bun:test";
import { join } from "node:path";
import { keeperShiftStartHashesInBrowser } from "../../apps/desktop/src/keeper-shift-hash";
import {
  createKeeperShiftIdentities,
  type KeeperShiftIdentities,
} from "../../apps/desktop/src/keeper-shift-identities";
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
import { createKeeperShiftReviewOwner } from "../../apps/desktop/src/keeper-shift-review-owner";
import type { ActionOutcome } from "../../docs/js/action-outcome";
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

function identities() {
  const values = new Map<string, string>();
  return createKeeperShiftIdentities({
    storage: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
    },
    withLock: async (work) => await work(),
  });
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
    "../../apps/desktop/src/use-keeper-shift-reviews.ts",
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

test("the app-root owner keeps a lost Start held and only explicit retry resends the exact reviewed UUID", async () => {
  const calls: KeeperShiftStartRequest[] = [];
  const replies: ActionOutcome[] = [
    { state: "unknown", message: "The Start reply was lost." },
    { state: "done", data: receiptFor("done", "running", actualShift()) },
  ];
  const owner = createKeeperShiftReviewOwner({
    canWrite: () => true,
    requestId: () => requestId,
    identities: identities(),
    readOptions: async () => shiftOptions(),
    readOriginal: async () => null,
    postStart: async (_projectId, _proposalId, request) => {
      calls.push(structuredClone(request));
      const reply = replies.shift();
      if (!reply) throw Error("Unexpected POST");
      return reply;
    },
  });
  const review = owner.get(source, 4);
  await owner.open(review);
  expect(review.state.status).toBe("ready");
  owner.edit(review, {
    for: "90m",
    concurrency: "3",
    maxBeads: "8",
    maxUsd: "12",
    repairs: "3",
    epic: "alpha-epic",
    smith: "claude-journeyman",
    runTimeout: "10m",
  });
  await owner.start(review);
  expect(review.state.status).toBe("held");
  expect(review.state.original).toEqual(fullRequest());
  expect(review.state.draft?.for).toBe("90m");
  expect(review.state.draft?.maxBeads).toBe("8");
  expect(calls).toHaveLength(1);

  await owner.check(review);
  expect(review.state.status).toBe("held");
  expect(review.state.draft?.for).toBe("90m");
  expect(review.state.draft?.maxBeads).toBe("8");
  expect(calls).toHaveLength(1);
  await owner.retry(review);
  expect(calls).toHaveLength(2);
  expect(calls[1]).toEqual(calls[0]);
  expect(review.state.status).toBe("recorded");
  owner.dispose();
});

test("failed options keep a saved identity and later protected original recovery remains available", async () => {
  const savedIdentities = identities();
  await savedIdentities.reserve(source, workspace, () => requestId);
  let available = false,
    originalReads = 0;
  const receipt = receiptFor("done", "running", actualShift());
  const owner = createKeeperShiftReviewOwner({
    canWrite: () => true,
    requestId: () => "a13c01ee-e854-4d0e-8d6c-a246304d74a2",
    identities: savedIdentities,
    readOptions: async () => {
      if (!available) throw Error("Options are offline.");
      return shiftOptions();
    },
    readOriginal: async (_projectId, _proposalId, id) => {
      originalReads += 1;
      expect(id).toBe(requestId);
      return receipt;
    },
    postStart: async () => {
      throw Error("Recovery reads must not POST.");
    },
  });
  const review = owner.get(source, 4);
  await owner.open(review);
  expect(review.state.requestId).toBe(requestId);
  expect(review.state.status).toBe("held");
  expect(originalReads).toBe(0);

  available = true;
  await owner.check(review);
  expect(originalReads).toBe(1);
  expect(review.state.status).toBe("recorded");
  expect(review.state.original).toEqual(receipt.original);
  owner.dispose();
});

test("a recorded-card original-only review never prepares a new Start without its saved UUID", async () => {
  let optionsReads = 0,
    originalReads = 0,
    startPosts = 0;
  const owner = createKeeperShiftReviewOwner({
    canWrite: () => true,
    requestId: () => requestId,
    identities: identities(),
    readOptions: async () => {
      optionsReads += 1;
      return shiftOptions();
    },
    readOriginal: async () => {
      originalReads += 1;
      return null;
    },
    postStart: async () => {
      startPosts += 1;
      return { state: "unknown", message: "Unexpected Start" };
    },
  });
  const review = owner.get(source, 4, true);
  await owner.open(review);
  await owner.start(review);
  await owner.retry(review);
  expect(review.state.status).toBe("held");
  expect(review.state.requestId).toBeNull();
  expect(optionsReads).toBe(0);
  expect(originalReads).toBe(0);
  expect(startPosts).toBe(0);
  owner.dispose();
});

test("a recorded-card UUID recovers its exact protected original without local identity metadata", async () => {
  const protectedReads: string[] = [],
    owner = createKeeperShiftReviewOwner({
      canWrite: () => true,
      requestId: () => "a13c01ee-e854-4d0e-8d6c-a246304d74a2",
      identities: identities(),
      readOptions: async () => shiftOptions(),
      readOriginal: async (_projectId, _proposalId, id) => {
        protectedReads.push(id);
        return receiptFor("done", "running", actualShift());
      },
      postStart: async () => {
        throw Error("Recovery must not send a Start");
      },
    });
  const review = owner.get(source, 4, true, requestId);
  await owner.open(review);
  expect(protectedReads).toEqual([requestId]);
  expect(review.state.status).toBe("recorded");
  expect(review.state.requestId).toBe(requestId);
  expect(review.state.original).toEqual(fullRequest());
  owner.dispose();
});

test("a conflicting or malformed recorded UUID stays held through open, check, start and retry", async () => {
  let optionsReads = 0,
    originalReads = 0,
    startPosts = 0;
  const owner = createKeeperShiftReviewOwner({
    canWrite: () => true,
    requestId: () => requestId,
    identities: identities(),
    readOptions: async () => {
      optionsReads += 1;
      return shiftOptions();
    },
    readOriginal: async () => {
      originalReads += 1;
      return receiptFor("done", "running", actualShift());
    },
    postStart: async () => {
      startPosts += 1;
      return { state: "unknown", message: "Unexpected Start" };
    },
  });
  const held = owner.get(source, 4);
  held.state.requestId = "a13c01ee-e854-4d0e-8d6c-a246304d74a2";
  const conflicting = owner.get(source, 4, true, requestId);
  await owner.open(conflicting);
  await owner.check(conflicting);
  await owner.start(conflicting);
  await owner.retry(conflicting);
  expect(conflicting.identityConflict).toBe(true);
  expect(conflicting.state.requestId).toBe(
    "a13c01ee-e854-4d0e-8d6c-a246304d74a2",
  );
  expect(conflicting.state.status).toBe("held");
  expect(optionsReads).toBe(0);
  expect(originalReads).toBe(0);
  expect(startPosts).toBe(0);

  const malformed = owner.get(source, 4, true, "not-a-uuid");
  await owner.open(malformed);
  expect(malformed.identityConflict).toBe(true);
  expect(malformed.state.status).toBe("held");
  expect(optionsReads).toBe(0);
  expect(originalReads).toBe(0);
  expect(startPosts).toBe(0);
  owner.dispose();
});

test("saved identity metadata survives unavailable options without crossing changed source or workspace", async () => {
  const values = new Map<string, string>();
  const savedIdentities = createKeeperShiftIdentities({
    storage: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
    },
    withLock: async (work) => await work(),
  });
  await savedIdentities.reserve(source, workspace, () => requestId);
  expect(savedIdentities.read(source)?.requestId).toBe(requestId);
  expect(() => savedIdentities.read(source, "C:/retargeted")).toThrow(
    "changed proposal source or workspace",
  );
  const changedSource = {
    ...structuredClone(source),
    sourceHash: "c".repeat(64),
  };
  expect(() => savedIdentities.read(changedSource)).toThrow(
    "changed proposal source or workspace",
  );
  const privateData = [...values.values()].join("\n");
  expect(privateData).toContain(requestId);
  expect(privateData).not.toContain("90m");
  expect(privateData).not.toContain("runTimeout");
});

test("closing a review while its protected original read is pending blocks the late receipt from reopening it", async () => {
  const savedIdentities = identities();
  await savedIdentities.reserve(source, workspace, () => requestId);
  let resolveOriginal!: (value: unknown) => void, markRead!: () => void;
  const reading = new Promise<unknown>((resolve) => {
    resolveOriginal = resolve;
  });
  const readStarted = new Promise<void>((resolve) => {
    markRead = resolve;
  });
  const owner = createKeeperShiftReviewOwner({
    canWrite: () => true,
    requestId: () => "a13c01ee-e854-4d0e-8d6c-a246304d74a2",
    identities: savedIdentities,
    readOptions: async () => shiftOptions(),
    readOriginal: async () => {
      markRead();
      return reading;
    },
    postStart: async () => {
      throw Error("A recovery read cannot post.");
    },
  });
  const review = owner.get(source, 4),
    opening = owner.open(review);
  await readStarted;
  owner.close(review);
  resolveOriginal(receiptFor("done", "running", actualShift()));
  await opening;
  expect(review.state.status).toBe("held");
  expect(review.state.receipt).toBeNull();
  owner.dispose();
});

test("closing after explicit Start owns identity reservation does not strand the UUID or cancel delivery", async () => {
  const backing = identities();
  let finishReservation!: (
      result: Awaited<ReturnType<KeeperShiftIdentities["reserve"]>>,
    ) => void,
    markReserve!: () => void;
  const reservation = new Promise<
    Awaited<ReturnType<KeeperShiftIdentities["reserve"]>>
  >((resolve) => {
    finishReservation = resolve;
  });
  const reserveStarted = new Promise<void>((resolve) => {
    markReserve = resolve;
  });
  const delayed: KeeperShiftIdentities = {
    read: backing.read,
    reserve: async () => {
      markReserve();
      return reservation;
    },
  };
  let writable = true;
  const calls: KeeperShiftStartRequest[] = [],
    owner = createKeeperShiftReviewOwner({
      canWrite: () => writable,
      requestId: () => requestId,
      identities: delayed,
      readOptions: async () => shiftOptions(),
      readOriginal: async () => null,
      postStart: async (_projectId, _proposalId, request) => {
        calls.push(structuredClone(request));
        return {
          state: "done",
          data: receiptFor("done", "running", actualShift()),
        };
      },
    });
  const review = owner.get(source, 4);
  await owner.open(review);
  owner.edit(review, {
    for: "90m",
    concurrency: "3",
    maxBeads: "8",
    maxUsd: "12",
    repairs: "3",
    epic: "alpha-epic",
    smith: "claude-journeyman",
    runTimeout: "10m",
  });
  const starting = owner.start(review);
  await reserveStarted;
  expect(review.state.original).toEqual(fullRequest());
  owner.close(review);
  finishReservation(await backing.reserve(source, workspace, () => requestId));
  await starting;
  expect(calls).toEqual([fullRequest()]);
  expect(review.state.requestId).toBe(requestId);
  expect(review.state.status).toBe("recorded");
  owner.dispose();
});

test("retry refuses a retained original when the project workspace was retargeted", async () => {
  const backing = identities();
  let currentOptions = shiftOptions(),
    reservations = 0;
  const calls: KeeperShiftStartRequest[] = [];
  const owner = createKeeperShiftReviewOwner({
    canWrite: () => true,
    requestId: () => requestId,
    identities: {
      read: backing.read,
      reserve: async (...args) => {
        reservations += 1;
        return await backing.reserve(...args);
      },
    },
    readOptions: async () => currentOptions,
    readOriginal: async () => null,
    postStart: async (_projectId, _proposalId, request) => {
      calls.push(structuredClone(request));
      return { state: "unknown", message: "The Start reply was lost." };
    },
  });
  const review = owner.get(source, 4);
  await owner.open(review);
  owner.edit(review, {
    for: "90m",
    concurrency: "3",
    maxBeads: "8",
    maxUsd: "12",
    repairs: "3",
    epic: "alpha-epic",
    smith: "claude-journeyman",
    runTimeout: "10m",
  });
  await owner.start(review);
  expect(review.state.original).toEqual(fullRequest());
  expect(reservations).toBe(1);
  expect(calls).toHaveLength(1);

  currentOptions = { ...shiftOptions(), workspace: "C:/retargeted" };
  await owner.check(review);
  expect(review.state.scopeVerified).toBe(false);
  expect(review.state.workspace).toBe(workspace.toLowerCase());
  expect(review.state.requestId).toBe(requestId);
  expect(review.state.original).toEqual(fullRequest());
  await owner.retry(review);
  expect(review.state.scopeVerified).toBe(false);
  expect(review.state.original).toEqual(fullRequest());
  expect(reservations).toBe(1);
  expect(calls).toHaveLength(1);
  owner.dispose();
});

test("retry keeps the UUID and original when current options are archived or unavailable", async () => {
  for (const current of [
    { ...shiftOptions(), availability: { start: false, reason: "Archived." } },
    new Error("Options are offline."),
  ]) {
    const backing = identities();
    let optionsReads = 0;
    const calls: KeeperShiftStartRequest[] = [];
    const owner = createKeeperShiftReviewOwner({
      canWrite: () => true,
      requestId: () => requestId,
      identities: backing,
      readOptions: async () => {
        optionsReads += 1;
        if (optionsReads === 1) return shiftOptions();
        if (current instanceof Error) throw current;
        return current;
      },
      readOriginal: async () => null,
      postStart: async (_projectId, _proposalId, request) => {
        calls.push(structuredClone(request));
        return { state: "unknown", message: "The Start reply was lost." };
      },
    });
    const review = owner.get(source, 4);
    await owner.open(review);
    owner.edit(review, {
      for: "90m",
      concurrency: "3",
      maxBeads: "8",
      maxUsd: "12",
      repairs: "3",
      epic: "alpha-epic",
      smith: "claude-journeyman",
      runTimeout: "10m",
    });
    await owner.start(review);
    const original = structuredClone(review.state.original);
    expect(original).toEqual(fullRequest());

    await owner.check(review);
    expect(review.state.scopeVerified).toBe(false);
    await owner.retry(review);
    expect(review.state.requestId).toBe(requestId);
    expect(review.state.original).toEqual(original);
    expect(review.state.scopeVerified).toBe(false);
    expect(calls).toHaveLength(1);
    owner.dispose();
  }
});

test("recovering a protected original does not certify an archived current scope", async () => {
  const saved = identities();
  await saved.reserve(source, workspace, () => requestId);
  let optionsReads = 0;
  const calls: KeeperShiftStartRequest[] = [];
  const archived = {
    ...shiftOptions(),
    availability: { start: false, reason: "Project is archived." },
  };
  const owner = createKeeperShiftReviewOwner({
    canWrite: () => true,
    requestId: () => requestId,
    identities: saved,
    readOptions: async () => {
      optionsReads += 1;
      return archived;
    },
    readOriginal: async () => receiptFor("unknown", null, null),
    postStart: async (_projectId, _proposalId, request) => {
      calls.push(structuredClone(request));
      return { state: "unknown", message: "Unexpected Start." };
    },
  });
  const review = owner.get(source, 4);
  await owner.open(review);
  expect(review.state.original).toEqual(fullRequest());
  expect(review.state.status).toBe("unknown");
  expect(review.state.scopeVerified).toBe(false);

  await owner.retry(review);
  expect(optionsReads).toBe(2);
  expect(review.state.requestId).toBe(requestId);
  expect(review.state.original).toEqual(fullRequest());
  expect(review.state.scopeVerified).toBe(false);
  expect(calls).toHaveLength(0);
  owner.dispose();
});

test("an uncertain identity save retains the full request so an explicit retry can reserve and deliver it unchanged", async () => {
  const backing = identities();
  let failures = 1;
  const calls: KeeperShiftStartRequest[] = [],
    owner = createKeeperShiftReviewOwner({
      canWrite: () => true,
      requestId: () => requestId,
      identities: {
        read: backing.read,
        reserve: async (...args) => {
          if (failures > 0) {
            failures -= 1;
            throw Error("Storage reply was lost.");
          }
          return backing.reserve(...args);
        },
      },
      readOptions: async () => shiftOptions(),
      readOriginal: async () => null,
      postStart: async (_projectId, _proposalId, request) => {
        calls.push(structuredClone(request));
        return {
          state: "done",
          data: receiptFor("done", "running", actualShift()),
        };
      },
    });
  const review = owner.get(source, 4);
  await owner.open(review);
  owner.edit(review, {
    for: "90m",
    concurrency: "3",
    maxBeads: "8",
    maxUsd: "12",
    repairs: "3",
    epic: "alpha-epic",
    smith: "claude-journeyman",
    runTimeout: "10m",
  });
  await owner.start(review);
  expect(review.state.status).toBe("held");
  expect(review.state.requestId).toBeNull();
  expect(review.state.original).toEqual(fullRequest());
  expect(calls).toHaveLength(0);
  await owner.retry(review);
  expect(calls).toEqual([fullRequest()]);
  expect(review.state.status).toBe("recorded");
  owner.dispose();
});

test("a newer proposal revision observed during asynchronous hashing aborts before identity reservation", async () => {
  let reservations = 0;
  const backing = identities(),
    owner = createKeeperShiftReviewOwner({
      canWrite: () => true,
      requestId: () => requestId,
      identities: {
        read: backing.read,
        reserve: async (...args) => {
          reservations += 1;
          return backing.reserve(...args);
        },
      },
      readOptions: async () => shiftOptions(),
      readOriginal: async () => null,
      postStart: async () => ({
        state: "unknown",
        message: "Unexpected POST",
      }),
    });
  const review = owner.get(source, 4);
  await owner.open(review);
  const starting = owner.start(review);
  expect(owner.get(source, 5)).toBe(review);
  await starting;
  expect(review.state.revision).toBe(5);
  expect(review.state.requestId).toBeNull();
  expect(review.state.original).toBeNull();
  expect(review.state.status).toBe("held");
  expect(reservations).toBe(0);
  owner.dispose();
});

test("a body changed under the same proposal hash is held instead of silently reusing the old review", async () => {
  const owner = createKeeperShiftReviewOwner({
    canWrite: () => true,
    requestId: () => requestId,
    identities: identities(),
    readOptions: async () => shiftOptions(),
    readOriginal: async () => null,
    postStart: async () => ({
      state: "unknown",
      message: "Unexpected POST",
    }),
  });
  const review = owner.get(source, 4);
  await owner.open(review);
  let notifications = 0;
  owner.subscribe(() => {
    notifications += 1;
  });
  const notificationsBeforeRead = notifications;
  const reordered = {
    createdAt: source.createdAt,
    sourceHash: source.sourceHash,
    sourceRequestId: source.sourceRequestId,
    projectId: source.projectId,
    id: source.id,
    draft: {
      action: {
        spendLimitUsd: 8,
        beadLimit: 5,
        concurrency: 2,
        durationMinutes: 45,
        kind: "start-shift" as const,
      },
      detail: source.draft.detail,
      title: source.draft.title,
    },
  };
  expect(owner.get(reordered, 4)).toBe(review);
  expect(review.state.status).toBe("ready");
  expect(notifications).toBe(notificationsBeforeRead);
  const changed = structuredClone(source);
  if (changed.draft.action.kind !== "start-shift")
    throw Error("Wrong proposal fixture");
  changed.draft.action.durationMinutes += 1;
  expect(owner.get(changed, 4)).toBe(review);
  expect(review.state.status).toBe("held");
  expect(review.state.notice).toContain(
    "changed without a new source identity",
  );
  expect(notifications).toBe(notificationsBeforeRead);
  expect(owner.get(changed, 4)).toBe(review);
  expect(notifications).toBe(notificationsBeforeRead);
  owner.dispose();
});

test("closing and reopening during options read starts a fresh read without stale loading state", async () => {
  let finishFirst!: (value: ProjectShiftOptions) => void,
    optionReads = 0;
  const firstOptions = new Promise<ProjectShiftOptions>((resolve) => {
    finishFirst = resolve;
  });
  const owner = createKeeperShiftReviewOwner({
    canWrite: () => true,
    requestId: () => requestId,
    identities: identities(),
    readOptions: async () => {
      optionReads += 1;
      return optionReads === 1 ? firstOptions : shiftOptions();
    },
    readOriginal: async () => null,
    postStart: async () => ({
      state: "unknown",
      message: "Unexpected POST",
    }),
  });
  const review = owner.get(source, 4),
    firstOpen = owner.open(review);
  expect(review.loading).toBe(true);
  owner.close(review);
  const secondOpen = owner.open(review);
  await secondOpen;
  expect(review.state.status).toBe("ready");
  expect(review.loading).toBe(false);
  finishFirst(shiftOptions());
  await firstOpen;
  expect(review.state.status).toBe("ready");
  expect(review.loading).toBe(false);
  expect(optionReads).toBe(2);
  owner.dispose();
});

test("opening another proposal while one Start is pending cannot paint or enable the other review", async () => {
  let resolvePost!: (outcome: ActionOutcome) => void, markPosted!: () => void;
  const posted = new Promise<void>((resolve) => {
    markPosted = resolve;
  });
  const owner = createKeeperShiftReviewOwner({
    canWrite: () => true,
    requestId: () => requestId,
    identities: identities(),
    readOptions: async () => shiftOptions(),
    readOriginal: async () => null,
    postStart: () =>
      new Promise<ActionOutcome>((resolve) => {
        resolvePost = resolve;
        markPosted();
      }),
  });
  const first = owner.get(source, 4);
  await owner.open(first);
  const start = owner.start(first);
  await posted;
  expect(first.starting).toBe(true);

  const anotherSource: KeeperProposal = {
    ...structuredClone(source),
    id: "proposal-2a5832fa-7a21-403b-8184-44892f0d8d86-0",
    sourceHash: "b".repeat(64),
  };
  const second = owner.get(anotherSource, 5);
  await owner.open(second);
  expect(second.state.status).toBe("ready");
  resolvePost({
    state: "done",
    data: receiptFor("done", "running", actualShift()),
  });
  await start;
  expect(first.state.status).toBe("held");
  expect(first.state.original?.start.requestId).toBe(requestId);
  expect(second.state.status).toBe("ready");
  expect(second.state.original).toBeNull();
  owner.dispose();
});
