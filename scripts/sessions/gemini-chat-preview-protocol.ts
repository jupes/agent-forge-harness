import { z } from "zod";
import type { GeminiChatPreviewReceipt } from "../../types/gemini-owned-chat";
import { preparedGeminiChatSchema } from "./gemini-chat-runtime-protocol";
import {
  GEMINI_TASK_MAX_STDIN_BYTES,
  serializeGeminiChat,
} from "./gemini-task";
import { sessionProjectIdSchema, sessionRequestIdSchema } from "./protocol";

export const MAX_GEMINI_CHAT_PREVIEW_BYTES = 2 * 3_145_728 + 65_536;

/** Private evidence only. Current project scope and execution authority remain server-owned. */
export const geminiChatPreviewReceiptSchema = z
  .object({
    provider: z.literal("gemini"),
    projectId: sessionProjectIdSchema,
    requestId: sessionRequestIdSchema,
    snapshot: preparedGeminiChatSchema,
    serialized: z
      .object({
        argv: z.array(z.string().max(8192)).max(128),
        stdin: z.string().max(GEMINI_TASK_MAX_STDIN_BYTES),
        inputFormat: z.literal("text"),
        equivalentCommand: z.string().max(65_536),
        stdinNote: z.string().max(1024),
        requiredFlags: z.array(z.string().max(80)).max(256),
      })
      .strict(),
  })
  .strict()
  .superRefine((value, ctx) => {
    try {
      const launch = value.snapshot.launch;
      if (
        launch.context?.projectId !== value.projectId ||
        launch.context.worktree !== launch.cwd ||
        launch.sandbox === false ||
        launch.policyFiles !== undefined ||
        launch.includeDirectories !== undefined ||
        new TextEncoder().encode(JSON.stringify(value)).byteLength >
          MAX_GEMINI_CHAT_PREVIEW_BYTES
      )
        throw Error("Foreign, unscoped or oversized preview");
      const expected = serializeGeminiChat(launch, value.snapshot.capabilities);
      if (JSON.stringify(expected) !== JSON.stringify(value.serialized))
        throw Error("Changed serialization");
    } catch {
      ctx.addIssue({
        code: "custom",
        message:
          "The Gemini Chat preview differs from its exact private preparation.",
      });
    }
  }) satisfies z.ZodType<GeminiChatPreviewReceipt>;
