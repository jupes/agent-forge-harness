import { z } from "zod";
import type {
  GeminiChatApprovalPage,
  GeminiChatDecisionReceipt,
  GeminiChatDecisionRequest,
  GeminiChatStartRequest,
} from "../../types/gemini-owned-chat";
import { ConversationError } from "../conversations/error";
import { reportedJsonSchema } from "./activity-protocol";
import { geminiChatLaunchSchema } from "./gemini-task";
import {
  ownedSessionIdSchema,
  sessionProjectIdSchema,
  sessionRequestIdSchema,
} from "./protocol";
import { sessionStartSchema } from "./request-protocol";

/** Chat uses the same bounded text selections, with no public paths or bypass. Defaults stay absent. */
export const geminiChatStartSchema = sessionStartSchema
  .omit({ launch: true })
  .extend({
    provider: z.literal("gemini"),
    launch: geminiChatLaunchSchema
      .omit({
        cwd: true,
        context: true,
        policyFiles: true,
        includeDirectories: true,
      })
      .extend({
        prompt: geminiChatLaunchSchema.shape.prompt.max(16_384),
        attachments: geminiChatLaunchSchema.shape.attachments
          .unwrap()
          .max(8)
          .optional(),
        sandbox: z.literal(true).optional(),
      })
      .strict(),
  })
  .strict()
  .transform(
    (value): GeminiChatStartRequest => ({
      ...value,
      launch: {
        route: value.launch.route,
        mode: value.launch.mode,
        prompt: value.launch.prompt,
        ...(value.launch.model === undefined
          ? {}
          : { model: value.launch.model }),
        ...(value.launch.approvalMode === undefined
          ? {}
          : { approvalMode: value.launch.approvalMode }),
        ...(value.launch.sandbox === undefined
          ? {}
          : { sandbox: value.launch.sandbox }),
        ...(value.launch.attachments === undefined
          ? {}
          : { attachments: value.launch.attachments }),
      },
    }),
  );
export const geminiChatDecisionRequestSchema = z
  .object({
    requestId: sessionRequestIdSchema,
    turnRequestId: sessionRequestIdSchema,
    approvalId: sessionRequestIdSchema,
    optionId: z.string().min(1).max(200).nullable(),
  })
  .strict() satisfies z.ZodType<GeminiChatDecisionRequest>;
export const geminiChatDecisionReceiptSchema = geminiChatDecisionRequestSchema
  .extend({
    projectId: sessionProjectIdSchema,
    sessionId: ownedSessionIdSchema,
    state: z.literal("recorded"),
    recordedAt: z.iso.datetime(),
  })
  .strict() satisfies z.ZodType<GeminiChatDecisionReceipt>;
export const geminiChatApprovalSchema = z
  .object({
    id: sessionRequestIdSchema,
    detail: reportedJsonSchema,
    detailsComplete: z.boolean(),
    options: z
      .array(
        z
          .object({
            optionId: z.string().min(1).max(200),
            name: z.string().min(1).max(200),
            kind: z.enum(["allow_once", "reject_once"]),
          })
          .strict(),
      )
      .max(16),
  })
  .strict()
  .refine(
    (value) =>
      new Set(value.options.map((item) => item.optionId)).size ===
        value.options.length &&
      (value.detailsComplete ||
        value.options.every((item) => item.kind !== "allow_once")),
  );
export const geminiChatApprovalPageSchema = z
  .object({
    pending: z
      .array(
        z
          .object({
            turnRequestId: sessionRequestIdSchema,
            actionable: z.literal(true),
            approval: geminiChatApprovalSchema,
          })
          .strict(),
      )
      .max(128),
    receipt: geminiChatDecisionReceiptSchema.nullable(),
  })
  .strict() satisfies z.ZodType<GeminiChatApprovalPage>;
export function parseGeminiChatDecision(
  input: unknown,
): GeminiChatDecisionRequest {
  const parsed = geminiChatDecisionRequestSchema.safeParse(input);
  if (!parsed.success)
    throw new ConversationError(
      400,
      "Expected an original decision UUID, accepted turn, opaque approval and offered one-time option or cancellation.",
    );
  return parsed.data;
}
