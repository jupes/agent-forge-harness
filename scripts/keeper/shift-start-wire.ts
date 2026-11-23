import { z } from "zod";
import type {
  KeeperShiftStartIntent,
  KeeperShiftStartProposal,
  KeeperShiftStartReceipt,
  KeeperShiftStartRequest,
} from "../../types/keeper-shift-start";
import { workspaceKey } from "../projects/scope";
import {
  sessionProjectIdSchema,
  sessionRequestHashSchema,
} from "../sessions/identity-protocol";
import {
  projectShiftReceiptSchema,
  projectShiftStartSchema,
} from "../shifts/protocol";
import { canonicalProjectShiftStart } from "../shifts/start-input";
import { keeperProposalRecordSchema } from "./proposal-protocol";

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
const workspacePath = z
  .string()
  .min(1)
  .max(1024)
  .refine((value) => value.trim() === value && !/[\p{Cc}\p{Cs}]/u.test(value))
  .refine(
    (value) =>
      value.startsWith("/") ||
      value.startsWith("\\\\") ||
      /^[a-zA-Z]:[\\/]/.test(value),
  );

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

export const keeperShiftStartIntentWireSchema: z.ZodType<KeeperShiftStartIntent> =
  z
    .object({
      projectId: sessionProjectIdSchema,
      proposalId: keeperShiftProposalIdSchema,
      workspace: workspacePath,
      proposal: keeperShiftStartProposalSchema,
      original: keeperShiftStartRequestSchema,
      startHash: sessionRequestHashSchema,
      reviewHash: sessionRequestHashSchema,
      createdAt: z.iso.datetime(),
    })
    .strict();

/** Exact canonical bytes shared by the server's sync SHA-256 and renderer WebCrypto. */
export function keeperShiftStartHashInputs(
  projectId: string,
  proposalId: string,
  workspace: string,
  proposal: KeeperShiftStartProposal,
  request: KeeperShiftStartRequest,
  startHash: string,
) {
  return {
    startInput: canonicalProjectShiftStart(projectId, workspace, request.start),
    reviewInput: JSON.stringify({
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
  };
}

export const keeperShiftStartReceiptWireSchema: z.ZodType<KeeperShiftStartReceipt> =
  z
    .object({
      projectId: sessionProjectIdSchema,
      proposalId: keeperShiftProposalIdSchema,
      revision: count,
      record: keeperProposalRecordSchema,
      workspace: workspacePath,
      original: keeperShiftStartRequestSchema,
      startHash: sessionRequestHashSchema,
      shift: projectShiftReceiptSchema.nullable(),
    })
    .strict()
    .refine((value) => {
      const action = value.record.draft.action;
      if (
        value.record.id !== value.proposalId ||
        value.record.projectId !== value.projectId ||
        value.record.sourceHash !== value.original.sourceHash ||
        value.record.requestId !== value.original.start.requestId ||
        value.record.operation !== "approve" ||
        action.kind !== "start-shift"
      )
        return false;
      // Hashes are checked asynchronously in the renderer and synchronously by
      // the server schema. Keep all non-cryptographic receipt associations here.
      return (
        value.shift === null ||
        (value.shift.intent.projectId === value.projectId &&
          workspaceKey(value.shift.intent.workspace) ===
            workspaceKey(value.workspace) &&
          value.shift.intent.requestHash === value.startHash &&
          canonicalProjectShiftStart(
            value.projectId,
            value.workspace,
            value.shift.intent.request,
          ) ===
            canonicalProjectShiftStart(
              value.projectId,
              value.workspace,
              value.original.start,
            ))
      );
    });
