import type { ConversationObject } from "../../types/conversation";
import type {
  GeminiChatOwnedMetadata,
  GeminiChatPreviewReceipt,
} from "../../types/gemini-owned-chat";
import { ConversationError } from "../conversations/error";
import { resolveCheckout } from "../ledger/workspace";
import {
  geminiChatLaunchFromStart,
  prepareReviewedGeminiChat,
} from "./gemini-chat-owned-preparation";
import { geminiChatStartSchema } from "./gemini-chat-owned-protocol";
import type { createGeminiChatRuntime } from "./gemini-chat-runtime";
import { serializeGeminiChat } from "./gemini-task";

/** Read-only native evidence only; this boundary cannot reserve a Start, journal or invoke a prompt. */
export function createGeminiChatPreview(options: {
  root: string;
  runtime: Pick<ReturnType<typeof createGeminiChatRuntime>, "prepare">;
  validateScope(
    projectId: string,
    scope: Pick<
      GeminiChatOwnedMetadata,
      "workspace" | "repository" | "worktree" | "beadId"
    >,
    about: ConversationObject[],
  ): Promise<void>;
}) {
  return async (
    projectId: string,
    raw: unknown,
  ): Promise<GeminiChatPreviewReceipt> => {
    const parsed = geminiChatStartSchema.safeParse(raw);
    if (!parsed.success)
      throw new ConversationError(
        400,
        "An explicit bounded Gemini ACP Chat preview request is required.",
      );
    const request = parsed.data,
      metadata = {
        workspace: resolveCheckout(options.root).workspace,
        repository: request.repository,
        worktree: request.worktree,
        ...(request.beadId === undefined ? {} : { beadId: request.beadId }),
      };
    await options.validateScope(projectId, metadata, request.about ?? []);
    const snapshot = await prepareReviewedGeminiChat(options.runtime, {
      smith: request.smith,
      launch: geminiChatLaunchFromStart(projectId, request),
    });
    await options.validateScope(projectId, metadata, request.about ?? []);
    return {
      provider: "gemini",
      projectId,
      requestId: request.requestId,
      snapshot,
      serialized: serializeGeminiChat(snapshot.launch, snapshot.capabilities),
    };
  };
}
