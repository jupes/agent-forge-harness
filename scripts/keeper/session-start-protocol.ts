import { z } from "zod";
import type {
  KeeperSessionStartIntent,
  KeeperSessionStartReceipt,
  KeeperSessionStartRequest,
} from "../../types/keeper-session-start";
import { conversationReceiptSchema } from "../conversations/protocol";
import {
  ownedSessionMetadataSchema,
  ownedSessionSchema,
  sessionProjectIdSchema,
  sessionRequestHashSchema,
} from "../sessions/protocol";
import { sessionStartSchema } from "../sessions/request-protocol";
import { keeperProposalRecordSchema } from "./proposal-protocol";

if (typeof window !== "undefined") z.config({ jitless: true });
export const MAX_KEEPER_SESSION_START_BODY_BYTES = 2_210_000;
export const keeperSessionProposalIdSchema = z
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
const encoder = new TextEncoder();

export const keeperSessionStartRequestSchema: z.ZodType<KeeperSessionStartRequest> =
  z
    .object({
      sourceHash: sessionRequestHashSchema,
      expectedRevision: count,
      start: sessionStartSchema,
    })
    .strict()
    .refine(
      (value) =>
        encoder.encode(JSON.stringify(value)).byteLength <=
          MAX_KEEPER_SESSION_START_BODY_BYTES &&
        encoder.encode(JSON.stringify(value.start)).byteLength <= 2_200_000,
      {
        message: "The reviewed session Start exceeds its private input bound.",
      },
    );

export const keeperSessionStartIntentSchema: z.ZodType<KeeperSessionStartIntent> =
  z
    .object({
      projectId: sessionProjectIdSchema,
      proposalId: keeperSessionProposalIdSchema,
      workspace: ownedSessionMetadataSchema.shape.workspace,
      original: keeperSessionStartRequestSchema,
      startHash: sessionRequestHashSchema,
      reviewHash: sessionRequestHashSchema,
      createdAt: z.iso.datetime(),
    })
    .strict();

export const keeperSessionStartReceiptSchema: z.ZodType<KeeperSessionStartReceipt> =
  z
    .object({
      projectId: sessionProjectIdSchema,
      proposalId: keeperSessionProposalIdSchema,
      revision: count,
      record: keeperProposalRecordSchema,
      original: keeperSessionStartRequestSchema,
      startHash: sessionRequestHashSchema,
      retryAvailable: z.boolean().optional(),
      session: ownedSessionSchema.nullable(),
      receipt: conversationReceiptSchema.nullable(),
    })
    .strict()
    .refine(
      (value) =>
        value.record.id === value.proposalId &&
        value.record.projectId === value.projectId &&
        value.record.sourceHash === value.original.sourceHash &&
        value.record.requestId === value.original.start.requestId &&
        value.record.operation === "approve" &&
        (value.retryAvailable !== true ||
          (!value.record.pending &&
            value.receipt === null &&
            (value.session === null ||
              (value.session.projectId === value.projectId &&
                value.session.requestId === value.original.start.requestId &&
                value.session.requestHash === value.startHash &&
                value.session.provider === "claude" &&
                value.session.mode === value.original.start.launch.mode)))) &&
        (value.session === null ||
          (value.session.projectId === value.projectId &&
            value.session.requestId === value.original.start.requestId &&
            value.session.requestHash === value.startHash)) &&
        (value.receipt === null ||
          (value.session !== null &&
            value.receipt.conversationId === value.session.id &&
            value.receipt.turn.requestId === value.original.start.requestId)),
    );
