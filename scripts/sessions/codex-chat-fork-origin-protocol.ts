/** Browser-safe metadata contract for a native Codex Chat Fork origin. */
import { z } from "zod";
import type { CodexChatForkOrigin } from "../../types/codex-chat-fork";
import {
  ownedSessionIdSchema,
  sessionProjectIdSchema,
  sessionRequestIdSchema,
} from "./identity-protocol";

export const CODEX_CHAT_FORK_PROTOCOL_VERSION = "0.163.0-alpha.10.2" as const;

const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const nativeUuidSchema = z
  .string()
  .uuid()
  .refine((value) => value === value.toLowerCase());

export const codexChatForkOriginSchema: z.ZodType<CodexChatForkOrigin> = z
  .object({
    kind: z.literal("codex-chat-fork"),
    projectId: sessionProjectIdSchema,
    parentSessionId: ownedSessionIdSchema,
    throughTurnRequestId: sessionRequestIdSchema,
    parentTurnHash: hashSchema,
    parentNativeThreadId: nativeUuidSchema,
    throughNativeTurnId: nativeUuidSchema,
    childNativeThreadId: nativeUuidSchema,
    captureHash: hashSchema,
    protocolVersion: z.literal(CODEX_CHAT_FORK_PROTOCOL_VERSION),
  })
  .strict()
  .refine((value) => value.parentNativeThreadId !== value.childNativeThreadId);
