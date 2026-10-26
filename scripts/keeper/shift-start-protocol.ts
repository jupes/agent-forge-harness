import type { z } from "zod";
import type {
  KeeperShiftStartIntent,
  KeeperShiftStartProposal,
  KeeperShiftStartRequest,
} from "../../types/keeper-shift-start";
import { parseDuration } from "../config/duration";
import { hashText } from "../hash-text";
import { workspaceKey } from "../projects/scope";
import {
  keeperShiftStartHashInputs,
  keeperShiftStartIntentWireSchema,
  keeperShiftStartReceiptWireSchema,
} from "./shift-start-wire";

export {
  keeperShiftProposalIdSchema,
  keeperShiftStartProposalSchema,
  keeperShiftStartRequestSchema,
} from "./shift-start-wire";

export const keeperShiftStartIntentSchema: z.ZodType<KeeperShiftStartIntent> =
  keeperShiftStartIntentWireSchema.refine((intent) => {
    const hashes = keeperShiftStartHashes(
      intent.projectId,
      intent.proposalId,
      intent.workspace,
      intent.proposal,
      intent.original,
    );
    return (
      intent.startHash === hashes.startHash &&
      intent.reviewHash === hashes.reviewHash
    );
  });

export const keeperShiftStartReceiptSchema =
  keeperShiftStartReceiptWireSchema.refine((value) => {
    const action = value.record.draft.action;
    if (action.kind !== "start-shift") return false;
    const proposal = {
      durationMinutes: action.durationMinutes,
      concurrency: action.concurrency,
      beadLimit: action.beadLimit,
      spendLimitUsd: action.spendLimitUsd,
    };
    const hashes = keeperShiftStartHashes(
      value.projectId,
      value.proposalId,
      value.workspace,
      proposal,
      value.original,
    );
    return (
      value.startHash === hashes.startHash &&
      value.record.requestHash === hashes.reviewHash
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
  const inputs = keeperShiftStartHashInputs(
    projectId,
    proposalId,
    workspace,
    proposal,
    request,
    "",
  );
  const startHash = hashText(inputs.startInput);
  const reviewInput = keeperShiftStartHashInputs(
    projectId,
    proposalId,
    workspace,
    proposal,
    request,
    startHash,
  ).reviewInput;
  return { startHash, reviewHash: hashText(reviewInput) };
}

/** Optional prefill comparison; edited full bounds are authorized by the reviewed request hash. */
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
      intent.reviewHash === hashes.reviewHash
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
