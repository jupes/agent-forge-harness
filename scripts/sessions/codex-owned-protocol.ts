import { z } from "zod";
import type {
  CodexTaskStartRequest,
  OwnedSessionStartRequest,
} from "../../types/codex-owned-task";
import { ConversationError } from "../conversations/error";
import { codexChatStartSchema } from "./codex-chat-owned-protocol";
import { codexTaskLaunchSchema } from "./codex-task";
import { geminiTaskStartSchema } from "./gemini-owned-protocol";
import { canonicalSessionInput } from "./preparation";
import { parseSessionStart, sessionStartSchema } from "./request-protocol";

/** Explicit additive branch; never infer a provider from a smith name or reinterpret Claude options. */
export const codexTaskStartSchema = sessionStartSchema
  .omit({ launch: true })
  .extend({
    provider: z.literal("codex"),
    launch: codexTaskLaunchSchema.omit({ cwd: true, context: true }).strict(),
  })
  .strict() satisfies z.ZodType<CodexTaskStartRequest>;

export function parseOwnedSessionStart(
  input: unknown,
): OwnedSessionStartRequest {
  if (
    typeof input === "object" &&
    input !== null &&
    Object.hasOwn(input, "provider")
  ) {
    const parsed = z
      .union([
        codexTaskStartSchema,
        codexChatStartSchema,
        geminiTaskStartSchema,
      ])
      .safeParse(input);
    if (!parsed.success)
      throw new ConversationError(
        400,
        "Expected explicit supported provider, route and mode selections with bounded native options.",
      );
    return parsed.data;
  }
  return parseSessionStart(input);
}

/** Legacy parsing and canonical bytes stay exact; explicit native branches add their own provider key. */
export function canonicalOwnedSessionStart(input: unknown): string {
  return canonicalSessionInput(parseOwnedSessionStart(input));
}
