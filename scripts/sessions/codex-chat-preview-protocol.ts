import { z } from "zod";
import type { CodexChatPreviewReceipt } from "../../types/codex-chat-ui";
import {
  CODEX_CHAT_MAX_BYTES,
  preparedCodexChatSchema,
  serializeCodexChat,
} from "./codex-app-server-protocol";
import { sessionProjectIdSchema, sessionRequestIdSchema } from "./protocol";

if (typeof window !== "undefined") z.config({ jitless: true });
export const MAX_CODEX_CHAT_PREVIEW_BYTES = 2 * CODEX_CHAT_MAX_BYTES + 65_536;

/** Capability evidence and protocol data only; the server remains execution authority. */
export const codexChatPreviewReceiptSchema = z
  .object({
    provider: z.literal("codex"),
    mode: z.literal("chat"),
    projectId: sessionProjectIdSchema,
    requestId: sessionRequestIdSchema,
    snapshot: preparedCodexChatSchema,
    serialized: z
      .object({
        argv: z.array(z.string().max(8192)).max(32),
        thread: z
          .object({
            model: z.string().min(1).max(200),
            cwd: z.string().min(1).max(1024),
            sandbox: z.enum(["read-only", "workspace-write"]),
            approvalPolicy: z.enum(["on-request", "never"]),
            approvalsReviewer: z.literal("user"),
            environments: z.tuple([]),
          })
          .strict(),
        input: z
          .object({
            type: z.literal("text"),
            text: z.string().max(CODEX_CHAT_MAX_BYTES),
            text_elements: z.tuple([]),
          })
          .strict(),
        effort: z.string().min(1).max(200).nullable(),
        equivalentCommand: z.string().max(65_536),
        stdinNote: z.string().max(1024),
      })
      .strict(),
  })
  .strict()
  .superRefine((value, ctx) => {
    try {
      if (
        value.snapshot.launch.context?.projectId !== value.projectId ||
        value.snapshot.launch.context.worktree !== value.snapshot.cwd ||
        new TextEncoder().encode(JSON.stringify(value)).byteLength >
          MAX_CODEX_CHAT_PREVIEW_BYTES
      )
        throw Error("Foreign or oversized preview");
      const expected = serializeCodexChat(
        value.snapshot.launch,
        value.snapshot.capabilities,
      );
      if (JSON.stringify(expected) !== JSON.stringify(value.serialized))
        throw Error("Changed native plan");
    } catch {
      ctx.addIssue({
        code: "custom",
        message:
          "The Codex Chat preview differs from its checked private preparation or exceeds its bound.",
      });
    }
  }) satisfies z.ZodType<CodexChatPreviewReceipt>;
