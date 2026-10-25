import { z } from "zod";
import type {
  KeeperShiftStartIntent,
  KeeperShiftStartProposal,
  KeeperShiftStartRequest,
} from "../../types/keeper-shift-start";
import { parseDuration } from "../config/duration";
import { hashText } from "../hash-text";
import { workspaceKey } from "../projects/scope";
import {
  ownedSessionMetadataSchema,
  sessionProjectIdSchema,
  sessionRequestHashSchema,
} from "../sessions/protocol";
import { projectShiftStartSchema } from "../shifts/protocol";
import { canonicalProjectShiftStart } from "../shifts/start-input";

if (typeof window !== "undefined") z.config({ jitless: true });

export const keeperShiftProposalIdSchema = z
  .string()
  .max(100)
  .regex(
    /^proposal-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[89ab][a-f0-9]{3}-[a-f0-9]{12}-[0-6]$/,
  );
const count = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER - 1);
export const keeperShiftStartProposalSchema: z.ZodType<KeeperShiftStartProposal> =
  z
    .object({
      durationMinutes: z.number().int().min(1).max(1440),
      concurrency: z.number().int().min(1).max(8),
      beadLimit: z.number().int().min(1).max(100),
      spendLimitUsd: z.number().finite().positive().max(1000),
    })
    .strict();

export const keeperShiftStartRequestSchema: z.ZodType<KeeperShiftStartRequest> =
  z
    .object({
      sourceHash: sessionRequestHashSchema,
      expectedRevision: count,
      start: projectShiftStartSchema,
    })
    .strict();

export const keeperShiftStartIntentSchema: z.ZodType<KeeperShiftStartIntent> = z
  .object({
    projectId: sessionProjectIdSchema,
    proposalId: keeperShiftProposalIdSchema,
    workspace: ownedSessionMetadataSchema.shape.workspace,
    proposal: keeperShiftStartProposalSchema,
    original: keeperShiftStartRequestSchema,
    startHash: sessionRequestHashSchema,
    reviewHash: sessionRequestHashSchema,
    createdAt: z.iso.datetime(),
  })
  .strict()
  .refine((intent) => {
    const hashes = keeperShiftStartHashes(
      intent.projectId,
      intent.proposalId,
      intent.workspace,
      intent.proposal,
      intent.original,
    );
    return (
      intent.startHash === hashes.startHash &&
      intent.reviewHash === hashes.reviewHash &&
      keeperShiftProposalMatches(intent.proposal, intent.original)
    );
  });

/** Stable review and start hashes; the full canonical request includes every optional bound. */
export function keeperShiftStartHashes(
  projectId: string,
  proposalId: string,
  workspace: string,
  proposal: KeeperShiftStartProposal,
  request: KeeperShiftStartRequest,
) {
  const startHash = hashText(
    canonicalProjectShiftStart(projectId, workspace, request.start),
  );
  const reviewHash = hashText(
    JSON.stringify({
      kind: "keeper.project-shift.start.v1",
      projectId,
      proposalId,
      workspace: workspaceKey(workspace),
      proposal: {
        durationMinutes: proposal.durationMinutes,
        concurrency: proposal.concurrency,
        beadLimit: proposal.beadLimit,
        spendLimitUsd: proposal.spendLimitUsd,
      },
      sourceHash: request.sourceHash,
      expectedRevision: request.expectedRevision,
      startHash,
      originalRequestId: request.start.requestId,
    }),
  );
  return { startHash, reviewHash };
}

/** The four compact proposal fields must still agree with the complete reviewed request. */
export function keeperShiftProposalMatches(
  proposal: KeeperShiftStartProposal,
  request: KeeperShiftStartRequest,
): boolean {
  const options = request.start.options;
  return (
    parseDuration(options.for) === proposal.durationMinutes * 60_000 &&
    options.concurrency === proposal.concurrency &&
    options.maxBeads === proposal.beadLimit &&
    options.maxUsd === proposal.spendLimitUsd
  );
}

/** Exact retries retain the original proposal, source, revision, scope and full Start. */
export function sameKeeperShiftStart(
  a: KeeperShiftStartIntent,
  b: KeeperShiftStartIntent,
): boolean {
  const intact = (intent: KeeperShiftStartIntent) => {
    const hashes = keeperShiftStartHashes(
      intent.projectId,
      intent.proposalId,
      intent.workspace,
      intent.proposal,
      intent.original,
    );
    return (
      intent.startHash === hashes.startHash &&
      intent.reviewHash === hashes.reviewHash &&
      keeperShiftProposalMatches(intent.proposal, intent.original)
    );
  };
  return (
    intact(a) &&
    intact(b) &&
    a.projectId === b.projectId &&
    a.proposalId === b.proposalId &&
    workspaceKey(a.workspace) === workspaceKey(b.workspace) &&
    a.startHash === b.startHash &&
    a.reviewHash === b.reviewHash
  );
}
