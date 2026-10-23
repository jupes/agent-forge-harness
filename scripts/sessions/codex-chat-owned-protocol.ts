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
