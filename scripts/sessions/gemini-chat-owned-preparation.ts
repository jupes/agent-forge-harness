import type { GeminiChatLaunch } from "../../types/gemini-chat-runtime";
import type { GeminiChatStartRequest } from "../../types/gemini-owned-chat";
import { ConversationError } from "../conversations/error";
import type { createGeminiChatRuntime } from "./gemini-chat-runtime";
import { preparedGeminiChatSchema } from "./gemini-chat-runtime-protocol";
import { canonicalSessionInput } from "./preparation";

/** Construction is pure; current scope and executable authority remain with admission. */
export function geminiChatLaunchFromStart(
  projectId: string,
  request: Omit<GeminiChatStartRequest, "requestId">,
): GeminiChatLaunch {
  return {
    ...structuredClone(request.launch),
    cwd: request.worktree,
    context: {
      projectId,
      repository: request.repository,
      worktree: request.worktree,
      ...(request.beadId === undefined ? {} : { beadId: request.beadId }),
      about: structuredClone(request.about ?? []),
    },
  };
}
export async function prepareReviewedGeminiChat(
  runtime: Pick<ReturnType<typeof createGeminiChatRuntime>, "prepare">,
  input: { smith: string; launch: GeminiChatLaunch },
) {
  const reviewed = structuredClone(input);
  let raw: unknown;
  try {
    raw = await runtime.prepare(structuredClone(reviewed));
  } catch {
    throw new ConversationError(
      503,
      "The selected Gemini Chat options are unavailable or lack exact native capability evidence. No turn was accepted.",
    );
  }
  const parsed = preparedGeminiChatSchema.safeParse(raw);
  if (
    !parsed.success ||
    parsed.data.smith !== reviewed.smith ||
    parsed.data.launch.cwd !== reviewed.launch.cwd ||
    canonicalSessionInput(parsed.data.launch) !==
      canonicalSessionInput(reviewed.launch)
  )
    throw new ConversationError(
      503,
      "The prepared Gemini Chat changed the reviewed private input. No turn was accepted.",
    );
  return parsed.data;
}
