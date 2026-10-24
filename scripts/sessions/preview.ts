import type { ConversationObject } from "../../types/conversation";
import type { OwnedSessionMetadata } from "../../types/owned-session";
import type { ClaudeSessionLaunch } from "../../types/session-launch";
import type { SessionPreviewReceipt } from "../../types/session-requests";
import { resolveCheckout } from "../ledger/workspace";
import type { SessionRuntime } from "./admission";
import { serializeClaudeLaunch } from "./claude-launch";
import { prepareReviewedSession } from "./preparation";
import { parseSessionStart } from "./request-protocol";

interface Options {
  root: string;
  runtime: SessionRuntime;
  validateScope(
    projectId: string,
    metadata: OwnedSessionMetadata,
    about: ConversationObject[],
    launch?: ClaudeSessionLaunch,
  ): Promise<void>;
}
/** Preparation only. No registry, private journal, dispatch or replay authority. */
export function createSessionPreview(options: Options) {
  return async (
    projectId: string,
    raw: unknown,
  ): Promise<SessionPreviewReceipt> => {
    const request = parseSessionStart(raw),
      about = request.about ?? [];
    const metadata: OwnedSessionMetadata = {
      mode: request.launch.mode,
      provider: "claude",
      workspace: resolveCheckout(options.root).workspace,
      repository: request.repository,
      worktree: request.worktree,
      ...(request.beadId ? { beadId: request.beadId } : {}),
      smith: request.smith,
      requestedModel: request.launch.model,
      requestedEffort: request.launch.effort ?? null,
    };
    const launch: ClaudeSessionLaunch = {
      ...request.launch,
      context: {
        projectId,
        repository: request.repository,
        worktree: request.worktree,
        ...(request.beadId ? { beadId: request.beadId } : {}),
        about,
      },
    };
    await options.validateScope(projectId, metadata, about, launch);
    const snapshot = await prepareReviewedSession(options.runtime, {
      smith: request.smith,
      cwd: request.worktree,
      launch,
    });
    await options.validateScope(projectId, metadata, about, launch);
    return {
      projectId,
      requestId: request.requestId,
      snapshot,
      serialized: serializeClaudeLaunch(snapshot.launch, snapshot.capabilities),
    };
  };
}
