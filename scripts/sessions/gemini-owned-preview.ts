import type { ConversationObject } from "../../types/conversation";
import type {
  GeminiOwnedSessionMetadata,
  GeminiTaskPreviewReceipt,
} from "../../types/gemini-owned-task";
import { ConversationError } from "../conversations/error";
import { resolveCheckout } from "../ledger/workspace";
import { parseOwnedSessionStart } from "./codex-owned-protocol";
import {
  geminiTaskLaunchFromStart,
  prepareReviewedGeminiTask,
} from "./gemini-owned-preparation";
import { serializeGeminiTask } from "./gemini-task";
import type { createGeminiTaskRuntime } from "./gemini-task-runtime";

/** Read-only evidence only. This boundary has no original reservation, journal or dispatch method. */
export function createGeminiTaskPreview(options: {
  root: string;
  runtime: Pick<ReturnType<typeof createGeminiTaskRuntime>, "prepare">;
  validateScope(
    projectId: string,
    scope: Pick<
      GeminiOwnedSessionMetadata,
      "workspace" | "repository" | "worktree" | "beadId"
    >,
    about: ConversationObject[],
  ): Promise<void>;
}) {
  return async (
    projectId: string,
    raw: unknown,
  ): Promise<GeminiTaskPreviewReceipt> => {
    const request = parseOwnedSessionStart(raw);
    if (!("provider" in request) || request.provider !== "gemini")
      throw new ConversationError(
        400,
        "An explicit Gemini CLI Task request is required.",
      );
    const metadata = {
      workspace: resolveCheckout(options.root).workspace,
      repository: request.repository,
      worktree: request.worktree,
      ...(request.beadId === undefined ? {} : { beadId: request.beadId }),
    };
    await options.validateScope(projectId, metadata, request.about ?? []);
    const snapshot = await prepareReviewedGeminiTask(options.runtime, {
      smith: request.smith,
      launch: geminiTaskLaunchFromStart(projectId, request),
    });
    await options.validateScope(projectId, metadata, request.about ?? []);
    return {
      provider: "gemini",
      projectId,
      requestId: request.requestId,
      snapshot,
      serialized: serializeGeminiTask(snapshot.launch, snapshot.capabilities),
    };
  };
}
