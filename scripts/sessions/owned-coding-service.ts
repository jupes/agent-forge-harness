import type { CodexChatDecisionRequest } from "../../types/codex-owned-chat";
import type { OwnedCodingSessionRecord } from "../../types/codex-owned-task";
import type { ConversationObject } from "../../types/conversation";
import type { GeminiChatDecisionRequest } from "../../types/gemini-owned-chat";
import type { OwnedSessionMetadata } from "../../types/owned-session";
import type { ClaudeSessionLaunch } from "../../types/session-launch";
import type { SessionMessage } from "../../types/session-turn";
import { ConversationError } from "../conversations/error";
import type { ConversationUpdate } from "../conversations/transport";
import { resolveCheckout } from "../ledger/workspace";
import { workspaceKey } from "../projects/scope";
import { createOwnedSessionService, type SessionRuntime } from "./admission";
import { createCodexOwnedChatService } from "./codex-chat-owned-admission";
import { parseCodexChatDecision } from "./codex-chat-owned-protocol";
import type { createCodexChatRuntime } from "./codex-chat-runtime";
import { createCodexOwnedTaskService } from "./codex-owned-admission";
import { parseOwnedSessionStart } from "./codex-owned-protocol";
import type { createCodexTaskRuntime } from "./codex-task-runtime";
import { createGeminiOwnedChatService } from "./gemini-chat-owned-admission";
import { parseGeminiChatDecision } from "./gemini-chat-owned-protocol";
import type { createGeminiChatRuntime } from "./gemini-chat-runtime";
import { createGeminiOwnedTaskService } from "./gemini-owned-admission";
import type { createGeminiTaskRuntime } from "./gemini-task-runtime";
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
export const unavailableCodexChatRuntime: ReturnType<
  typeof createCodexChatRuntime
> = {
  async check() {
    throw new ConversationError(503, "The Codex Chat runtime is unavailable.");
  },
  async prepare() {
    throw new ConversationError(503, "The Codex Chat runtime is unavailable.");
  },
  async run() {
    throw new ConversationError(503, "The Codex Chat runtime is unavailable.");
  },
};
export const unavailableGeminiTaskRuntime: ReturnType<
  typeof createGeminiTaskRuntime
> = {
  async check() {
    throw new ConversationError(503, "The Gemini Task runtime is unavailable.");
  },
  async prepare() {
    throw new ConversationError(503, "The Gemini Task runtime is unavailable.");
  },
  async run() {
    throw new ConversationError(503, "The Gemini Task runtime is unavailable.");
  },
};
export const unavailableGeminiChatRuntime: ReturnType<
  typeof createGeminiChatRuntime
> = {
  async prepare() {
    throw new ConversationError(
      503,
      "The Gemini ACP Chat runtime is unavailable.",
    );
  },
  async run() {
    throw new ConversationError(
      503,
      "The Gemini ACP Chat runtime is unavailable.",
    );
  },
};
/** Routing only. Neither a smith name nor a provider fallback can select an execution branch. */
export function createOwnedCodingSessionService(options: {
  root: string;
  home: string;
  runtime: SessionRuntime;
  codexTaskRuntime?: ReturnType<typeof createCodexTaskRuntime> | undefined;
  codexChatRuntime?: ReturnType<typeof createCodexChatRuntime> | undefined;
  geminiTaskRuntime?: ReturnType<typeof createGeminiTaskRuntime> | undefined;
  geminiChatRuntime?: ReturnType<typeof createGeminiChatRuntime> | undefined;
  onApprovalChange?(sessionId: string): void;
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
  const chat = createCodexOwnedChatService({
    ...options,
    runtime: options.codexChatRuntime ?? unavailableCodexChatRuntime,
  });
  const gemini = createGeminiOwnedTaskService({
    ...options,
    runtime: options.geminiTaskRuntime ?? unavailableGeminiTaskRuntime,
  });
  const geminiChat = createGeminiOwnedChatService({
    ...options,
    runtime: options.geminiChatRuntime ?? unavailableGeminiChatRuntime,
  });
  const selected = (projectId: string, sessionId: string) => {
    const record = registry.lookup(projectId, sessionId);
    requireOrdinarySession(record);
    if (record.provider === "gemini")
      return record.mode === "chat" ? geminiChat : gemini;
    return record.provider === "codex"
      ? record.mode === "chat"
        ? chat
        : codex
      : claude;
  };
  const selectedChat = (projectId: string, sessionId: string) => {
    const record = registry.lookup(projectId, sessionId);
    requireOrdinarySession(record);
    if (
      record.mode !== "chat" ||
      (record.provider !== "codex" && record.provider !== "gemini")
    )
      throw new ConversationError(
        409,
        "This session has no native Chat permission protocol.",
      );
    return record.provider === "gemini" ? geminiChat : chat;
  };
  return {
    start(projectId: string, raw: unknown) {
      const request = parseOwnedSessionStart(raw);
      if ("provider" in request && request.provider === "gemini")
        return request.launch.mode === "chat"
          ? geminiChat.start(projectId, request)
          : gemini.start(projectId, request);
      return "provider" in request
        ? request.launch.mode === "chat"
          ? chat.start(projectId, request)
          : codex.start(projectId, request)
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
    approvals(projectId: string, sessionId: string, requestId?: string) {
      return selectedChat(projectId, sessionId).approvals(
        projectId,
        sessionId,
        requestId,
      );
    },
    decide(
      projectId: string,
      sessionId: string,
      request: CodexChatDecisionRequest | GeminiChatDecisionRequest,
    ) {
      const record = registry.lookup(projectId, sessionId);
      requireOrdinarySession(record);
      if (record.mode !== "chat")
        throw new ConversationError(
          409,
          "This session has no native Chat permission protocol.",
        );
      if (record.provider === "gemini")
        return geminiChat.decide(
          projectId,
          sessionId,
          parseGeminiChatDecision(request),
        );
      if (record.provider === "codex")
        return chat.decide(
          projectId,
          sessionId,
          parseCodexChatDecision(request),
        );
      throw new ConversationError(
        409,
        "This session has no native Chat permission protocol.",
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
      await Promise.all([
        claude.close(),
        codex.close(),
        chat.close(),
        gemini.close(),
        geminiChat.close(),
      ]);
    },
  };
}
