import type { CodexChatPreviewReceipt } from "../../types/codex-chat-ui";
import type { CodexChatOwnedMetadata } from "../../types/codex-owned-chat";
import type { ConversationObject } from "../../types/conversation";
import { ConversationError } from "../conversations/error";
import { resolveCheckout } from "../ledger/workspace";
import { serializeCodexChat } from "./codex-app-server-protocol";
import {
  codexChatLaunchFromStart,
  prepareReviewedCodexChat,
} from "./codex-chat-owned-preparation";
import type { createCodexChatRuntime } from "./codex-chat-runtime";
import { parseOwnedSessionStart } from "./codex-owned-protocol";

export function createCodexChatPreview(options: {
  root: string;
  runtime: Pick<ReturnType<typeof createCodexChatRuntime>, "prepare">;
  validateScope(
    projectId: string,
    metadata: Pick<
      CodexChatOwnedMetadata,
      "workspace" | "repository" | "worktree" | "beadId"
    >,
    about: ConversationObject[],
  ): Promise<void>;
}) {
  return async (
    projectId: string,
    raw: unknown,
  ): Promise<CodexChatPreviewReceipt> => {
    const request = parseOwnedSessionStart(raw);
    if (!("provider" in request) || request.launch.mode !== "chat")
      throw new ConversationError(400, "An explicit Codex Chat is required.");
    const metadata = {
      workspace: resolveCheckout(options.root).workspace,
      repository: request.repository,
      worktree: request.worktree,
      ...(request.beadId ? { beadId: request.beadId } : {}),
    };
    await options.validateScope(projectId, metadata, request.about ?? []);
    const snapshot = await prepareReviewedCodexChat(options.runtime, {
      smith: request.smith,
      launch: codexChatLaunchFromStart(projectId, {
        ...request,
        launch: { ...request.launch, mode: "chat" },
      }),
    });
    await options.validateScope(projectId, metadata, request.about ?? []);
    return {
      provider: "codex",
      mode: "chat",
      projectId,
      requestId: request.requestId,
      snapshot,
      serialized: serializeCodexChat(snapshot.launch, snapshot.capabilities),
    };
  };
}
