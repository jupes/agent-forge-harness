import { z } from "zod";
import type {
  CodexChatDecisionReceipt,
  CodexChatDecisionRequest,
  CodexChatStartRequest,
} from "../../types/codex-owned-chat";
import { ConversationError } from "../conversations/error";
import { codexTaskLaunchSchema } from "./codex-task";
import {
  ownedSessionIdSchema,
  sessionProjectIdSchema,
  sessionRequestIdSchema,
} from "./protocol";
import { sessionStartSchema } from "./request-protocol";

export const CODEX_FILE_DETAILS_UNAVAILABLE =
  "Actual file-change details are unavailable. Allow is disabled.";

export const codexChatStartSchema = sessionStartSchema
  .omit({ launch: true })
  .extend({
    provider: z.literal("codex"),
    launch: codexTaskLaunchSchema
      .omit({ cwd: true, context: true, mode: true, approvalPolicy: true })
      .extend({
        mode: z.literal("chat"),
        approvalPolicy: z.enum(["on-request", "never"]),
      })
      .strict(),
  })
  .strict() satisfies z.ZodType<CodexChatStartRequest>;
export const codexChatDecisionRequestSchema = z
  .object({
    requestId: sessionRequestIdSchema,
    turnRequestId: sessionRequestIdSchema,
    approvalId: sessionRequestIdSchema,
    decision: z.enum(["accept", "decline", "cancel"]),
  })
  .strict() satisfies z.ZodType<CodexChatDecisionRequest>;
export const codexChatDecisionReceiptSchema = codexChatDecisionRequestSchema
  .extend({
    projectId: sessionProjectIdSchema,
    sessionId: ownedSessionIdSchema,
    state: z.literal("recorded"),
    recordedAt: z.iso.datetime(),
  })
  .strict() satisfies z.ZodType<CodexChatDecisionReceipt>;

export const codexChatApprovalPageSchema = z
  .object({
    pending: z
      .array(
        z
          .object({
            turnRequestId: sessionRequestIdSchema,
            actionable: z.literal(true),
            detailsUnavailableReason: z
              .literal(CODEX_FILE_DETAILS_UNAVAILABLE)
              .nullable(),
            approval: z
              .object({
                id: sessionRequestIdSchema,
                kind: z.enum(["command", "file-change"]),
                command: z.string().max(16_384).nullable(),
                cwd: z.string().max(1024).nullable(),
                reason: z.string().max(16_384).nullable(),
                availableDecisions: z
                  .array(z.enum(["accept", "decline", "cancel"]))
                  .min(1)
                  .max(3),
              })
              .strict(),
          })
          .strict()
          .refine((value) =>
            value.approval.kind === "file-change"
              ? value.detailsUnavailableReason ===
                  CODEX_FILE_DETAILS_UNAVAILABLE &&
                !value.approval.availableDecisions.includes("accept")
              : value.detailsUnavailableReason === null &&
                !!value.approval.command &&
                !!value.approval.cwd,
          ),
      )
      .max(128),
    receipt: codexChatDecisionReceiptSchema.nullable(),
  })
  .strict();

export function parseCodexChatDecision(
  input: unknown,
): CodexChatDecisionRequest {
  const parsed = codexChatDecisionRequestSchema.safeParse(input);
  if (!parsed.success)
    throw new ConversationError(
      400,
      "Expected an original decision UUID, accepted turn, opaque approval and offered narrow decision.",
    );
  return parsed.data;
}
