import type {
  CodexOwnedSessionMetadata,
  CodexTaskPreviewReceipt,
} from "../../types/codex-owned-task";
import type { ConversationObject } from "../../types/conversation";
import { ConversationError } from "../conversations/error";
import { resolveCheckout } from "../ledger/workspace";
import {
  codexTaskLaunchFromStart,
  prepareReviewedCodexTask,
} from "./codex-owned-preparation";
import { parseOwnedSessionStart } from "./codex-owned-protocol";
import { serializeCodexTask } from "./codex-task";
import type { createCodexTaskRuntime } from "./codex-task-runtime";

export function createCodexTaskPreview(options: {
  root: string;
  runtime: ReturnType<typeof createCodexTaskRuntime>;
  validateScope(
    projectId: string,
    metadata: Pick<
      CodexOwnedSessionMetadata,
      "workspace" | "repository" | "worktree" | "beadId"
    >,
    about: ConversationObject[],
  ): Promise<void>;
}) {
  return async (
    projectId: string,
    raw: unknown,
  ): Promise<CodexTaskPreviewReceipt> => {
    const request = parseOwnedSessionStart(raw);
    if (!("provider" in request))
      throw new ConversationError(
        400,
        "An explicit Codex Task provider is required.",
      );
    const metadata = {
      workspace: resolveCheckout(options.root).workspace,
      repository: request.repository,
      worktree: request.worktree,
      ...(request.beadId ? { beadId: request.beadId } : {}),
    };
    await options.validateScope(projectId, metadata, request.about ?? []);
    const snapshot = await prepareReviewedCodexTask(options.runtime, {
      smith: request.smith,
      launch: codexTaskLaunchFromStart(projectId, request),
    });
    await options.validateScope(projectId, metadata, request.about ?? []);
    return {
      provider: "codex",
      projectId,
      requestId: request.requestId,
      snapshot,
      serialized: serializeCodexTask(snapshot.launch, snapshot.capabilities),
    };
  };
}
