import type { OwnedCodingSessionRecord } from "../../types/codex-owned-task";
import type { ConversationObject } from "../../types/conversation";
import type { OwnedSessionMetadata } from "../../types/owned-session";
import type { ClaudeSessionLaunch } from "../../types/session-launch";
import type { SessionMessage } from "../../types/session-turn";
import { ConversationError } from "../conversations/error";
import type { ConversationUpdate } from "../conversations/transport";
import { resolveCheckout } from "../ledger/workspace";
import { workspaceKey } from "../projects/scope";
import { createOwnedSessionService, type SessionRuntime } from "./admission";
import { createCodexOwnedTaskService } from "./codex-owned-admission";
import { parseOwnedSessionStart } from "./codex-owned-protocol";
import type { createCodexTaskRuntime } from "./codex-task-runtime";
import { requireOrdinarySession } from "./managed-origin";
import { createSessionRegistry } from "./registry";

export const unavailableCodexTaskRuntime: ReturnType<
  typeof createCodexTaskRuntime
> = {
  async check() {
    throw new ConversationError(503, "The Codex Task runtime is unavailable.");
  },
  async prepare() {
    throw new ConversationError(503, "The Codex Task runtime is unavailable.");
  },
  async run() {
    throw new ConversationError(503, "The Codex Task runtime is unavailable.");
  },
};
/** Routing only. Neither a smith name nor a provider fallback can select an execution branch. */
export function createOwnedCodingSessionService(options: {
  root: string;
  home: string;
  runtime: SessionRuntime;
  codexTaskRuntime?: ReturnType<typeof createCodexTaskRuntime> | undefined;
  validateScope(
    projectId: string,
    metadata: Pick<
      OwnedSessionMetadata,
      "workspace" | "repository" | "worktree" | "beadId"
    >,
    about: ConversationObject[],
    launch?: ClaudeSessionLaunch,
  ): Promise<void>;
  onChange?(
    session: OwnedCodingSessionRecord,
    update: ConversationUpdate,
  ): void;
}) {
  const claude = createOwnedSessionService(options);
  const codex = createCodexOwnedTaskService({
    ...options,
    runtime: options.codexTaskRuntime ?? unavailableCodexTaskRuntime,
  });
  const registry = createSessionRegistry(options.home);
  const selected = (projectId: string, sessionId: string) => {
    const record = registry.lookup(projectId, sessionId);
    requireOrdinarySession(record);
    return record.provider === "codex" ? codex : claude;
  };
  return {
    start(projectId: string, raw: unknown) {
      const request = parseOwnedSessionStart(raw);
      return "provider" in request
        ? codex.start(projectId, request)
        : claude.start(projectId, request);
    },
    send(projectId: string, sessionId: string, input: SessionMessage) {
      return selected(projectId, sessionId).send(projectId, sessionId, input);
    },
    read(
      projectId: string,
      sessionId: string,
      query: { after?: number; limit?: number; requestId?: string } = {},
    ) {
      return selected(projectId, sessionId).read(projectId, sessionId, query);
    },
    list(projectId: string) {
      const workspace = workspaceKey(resolveCheckout(options.root).workspace);
      return registry
        .listAll(projectId)
        .filter(
          (record) =>
            !record.origin && workspaceKey(record.workspace) === workspace,
        );
    },
    stop(projectId: string, sessionId: string, requestId: string) {
      return selected(projectId, sessionId).stop(
        projectId,
        sessionId,
        requestId,
      );
    },
    settled(projectId: string, sessionId: string) {
      return selected(projectId, sessionId).settled(projectId, sessionId);
    },
    async close() {
      await Promise.all([claude.close(), codex.close()]);
    },
  };
}
