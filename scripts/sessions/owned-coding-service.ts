import { createHash } from "node:crypto";
import type { CodexChatForkOriginal } from "../../types/codex-chat-fork";
import type { CodexChatDecisionRequest } from "../../types/codex-owned-chat";
import type { OwnedCodingSessionRecord } from "../../types/codex-owned-task";
import type { ConversationObject } from "../../types/conversation";
import type { GeminiChatDecisionRequest } from "../../types/gemini-owned-chat";
import type { OwnedSessionMetadata } from "../../types/owned-session";
import type { ClaudeSessionLaunch } from "../../types/session-launch";
import type {
  CodexChatForkIdentityMetadata,
  SessionOperationIdentityPage,
} from "../../types/session-operation-identities";
import type {
  SessionStartIdentityMetadata,
  SessionStartIdentityPage,
  SessionStartIdentityReply,
} from "../../types/session-start-identities";
import type { SessionMessage } from "../../types/session-turn";
import { ConversationError } from "../conversations/error";
import type { ConversationUpdate } from "../conversations/transport";
import {
  createInitialStartAttempt,
  type InitialStartAttempt,
  proofForInitialStartRefusal,
} from "../identities/preaccept-not-sent-proof";
import {
  createRestartIdentityJournal,
  type RestartIdentityInput,
  RestartIdentityJournalError,
  type RestartIdentityRow,
} from "../identities/restart-index";
import { resolveCheckout } from "../ledger/workspace";
import { workspaceKey } from "../projects/scope";
import { createOwnedSessionService, type SessionRuntime } from "./admission";
import {
  CodexChatForkOriginalConflict,
  createCodexChatForkCoordinator,
} from "./codex-chat-fork-coordinator";
import { CodexChatForkJournalError } from "./codex-chat-fork-journal";
import { createCodexOwnedChatService } from "./codex-chat-owned-admission";
import { parseCodexChatDecision } from "./codex-chat-owned-protocol";
import type { createCodexChatRuntime } from "./codex-chat-runtime";
import { createCodexOwnedTaskService } from "./codex-owned-admission";
import {
  canonicalOwnedSessionStart,
  parseOwnedSessionStart,
} from "./codex-owned-protocol";
import type { createCodexTaskRuntime } from "./codex-task-runtime";
import { createGeminiOwnedChatService } from "./gemini-chat-owned-admission";
import { parseGeminiChatDecision } from "./gemini-chat-owned-protocol";
import type { createGeminiChatRuntime } from "./gemini-chat-runtime";
import { createGeminiOwnedTaskService } from "./gemini-owned-admission";
import type { createGeminiTaskRuntime } from "./gemini-task-runtime";
import { requireOrdinarySession } from "./managed-origin";
import { createSessionRegistry } from "./registry";
import { readVerifiedOriginalStart } from "./restart-identity-proof";
import { readSessionOperationIdentityPage } from "./session-operation-identities-protocol";

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
  async fork() {
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
  const workspace = workspaceKey(resolveCheckout(options.root).workspace);
  const identities = createRestartIdentityJournal(options.home, {
    verifyAdmission(input) {
      const proof = readVerifiedOriginalStart({
        home: options.home,
        root: options.root,
        identity: input,
      });
      return proof.kind === "verified" ? proof.value : null;
    },
  });
  const forkCoordinator = createCodexChatForkCoordinator({
    root: options.root,
    home: options.home,
    runtime: options.codexChatRuntime ?? unavailableCodexChatRuntime,
    validateScope: (parent, about = [], launch) =>
      options.validateScope(parent.projectId, parent, about, launch),
  });
  const held = () =>
    new ConversationError(
      503,
      "The original Session Start could not be verified. Its identity remains held; retrying will not dispatch another provider request.",
    );
  const registryConflict = () =>
    new ConversationError(
      409,
      "This Session Start UUID is already bound to another project or workspace.",
    );
  const scopeFor = (projectId: string) => ({
    address: { family: "owned-session-start" as const, projectId },
    workspace,
  });
  const publicScope = (projectId: string) => ({
    family: "owned-session-start" as const,
    projectId,
    workspace,
  });
  const metadata = (row: RestartIdentityRow) => {
    return {
      version: 1 as const,
      requestId: row.requestId,
      requestHash: row.requestHash,
      provider: row.provider,
      mode: row.mode,
      state: row.state,
    } satisfies SessionStartIdentityMetadata;
  };
  const forkMetadata = (
    row: CodexChatForkOriginal,
  ): CodexChatForkIdentityMetadata => ({
    family: "codex-chat-fork",
    requestId: row.requestId,
    requestHash: row.requestHash,
    parentSessionId: row.parentSessionId,
    throughTurnRequestId: row.throughTurnRequestId,
    state: row.state,
    ...(row.state === "linked"
      ? { childSessionId: row.childAppSessionId }
      : {}),
    ...(row.state === "held" ? { heldReason: row.heldReason } : {}),
  });
  const forkJournalFailure = (error: CodexChatForkJournalError) =>
    new ConversationError(
      error.reason === "conflict"
        ? 409
        : error.reason === "missing"
          ? 404
          : 503,
      error.reason === "conflict"
        ? "This Codex Fork UUID belongs to another immutable original."
        : error.reason === "missing"
          ? "The exact Codex Fork original is not present in this trusted workspace."
          : "The private Codex Fork journal is held or unavailable.",
    );
  const identityFor = (
    projectId: string,
    raw: unknown,
  ): RestartIdentityInput => {
    const request = parseOwnedSessionStart(raw);
    const provider: RestartIdentityInput["provider"] =
      "provider" in request ? request.provider : "claude";
    return {
      version: 1,
      address: { family: "owned-session-start", projectId },
      workspace,
      requestId: request.requestId,
      requestHash: createHash("sha256")
        .update(canonicalOwnedSessionStart(request))
        .digest("hex"),
      provider,
      mode: request.launch.mode,
    };
  };
  const verifyOriginal = (identity: RestartIdentityInput) => {
    try {
      return readVerifiedOriginalStart({
        home: options.home,
        root: options.root,
        identity,
      });
    } catch {
      return { kind: "invalid" as const };
    }
  };
  const validateNewScope = async (
    projectId: string,
    request: ReturnType<typeof parseOwnedSessionStart>,
  ) =>
    options.validateScope(
      projectId,
      {
        workspace: resolveCheckout(options.root).workspace,
        repository: request.repository,
        worktree: request.worktree,
        ...(request.beadId === undefined ? {} : { beadId: request.beadId }),
      },
      request.about ?? [],
      "provider" in request ? undefined : request.launch,
    );
  const dispatchStart = (
    projectId: string,
    request: ReturnType<typeof parseOwnedSessionStart>,
    attempt?: InitialStartAttempt,
  ) => {
    if ("provider" in request && request.provider === "gemini")
      return request.launch.mode === "chat"
        ? geminiChat.start(projectId, request, attempt)
        : gemini.start(projectId, request, attempt);
    return "provider" in request
      ? request.launch.mode === "chat"
        ? chat.start(projectId, request, attempt)
        : codex.start(projectId, request, attempt)
      : claude.start(projectId, request, attempt);
  };
  const chat = createCodexOwnedChatService({
    ...options,
    runtime: options.codexChatRuntime ?? unavailableCodexChatRuntime,
    prepareForkChildTurn: (child, input) =>
      forkCoordinator.prepareLinkedChildTurn({
        projectId: child.projectId,
        childSessionId: child.id,
        message: input,
        validateScope: (selected, about) =>
          options.validateScope(selected.projectId, selected, about),
      }),
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
    async reserveIdentity(
      projectId: string,
      raw: unknown,
    ): Promise<SessionStartIdentityReply> {
      const request = parseOwnedSessionStart(raw);
      const identity = identityFor(projectId, request);
      const source = verifyOriginal(identity);
      if (source.kind === "conflict") throw registryConflict();
      if (source.kind === "invalid") throw held();
      let prior: RestartIdentityRow | null;
      try {
        prior = await identities.lookup(
          scopeFor(projectId),
          identity.requestId,
        );
      } catch {
        throw new ConversationError(
          503,
          "Session Start identities are unavailable.",
        );
      }
      if (prior !== null && prior.requestHash !== identity.requestHash)
        throw new ConversationError(
          409,
          "This Session Start identity is already reserved.",
        );
      if (prior === null && source.kind === "missing")
        await validateNewScope(projectId, request);
      try {
        prior = await identities.reserve(identity);
        if (source.kind === "verified") {
          if (prior.state === "reserved")
            await identities.beginAttempt(identity);
          const admitted = await identities.admit(identity);
          return {
            version: 1,
            scope: publicScope(projectId),
            identity: metadata(admitted.row),
          };
        }
        if (prior.state === "attempted" || prior.state === "admitted") {
          const admitted = await identities.admit(identity);
          return {
            version: 1,
            scope: publicScope(projectId),
            identity: metadata(admitted.row),
          };
        }
        return {
          version: 1,
          scope: publicScope(projectId),
          identity: metadata(prior),
        };
      } catch (error) {
        if (error instanceof ConversationError) throw error;
        throw new ConversationError(
          error instanceof Error && "kind" in error && error.kind === "conflict"
            ? 409
            : 503,
          "The Session Start identity could not be safely reserved.",
        );
      }
    },
    async listIdentities(projectId: string): Promise<SessionStartIdentityPage> {
      try {
        const rows = await identities.list(scopeFor(projectId));
        return {
          version: 1,
          scope: publicScope(projectId),
          identities: rows.map(metadata),
        };
      } catch {
        throw new ConversationError(
          503,
          "Session Start identities are unavailable.",
        );
      }
    },
    async fork(
      projectId: string,
      parentSessionId: string,
      request: unknown,
      auditEventId: number,
    ): Promise<CodexChatForkIdentityMetadata> {
      if (!Number.isSafeInteger(auditEventId) || auditEventId <= 0)
        throw new ConversationError(
          503,
          "A confirmed operator audit receipt is required before Fork.",
        );
      try {
        await forkCoordinator.fork({
          projectId,
          parentSessionId,
          request,
          auditEventId,
        });
        const original = forkCoordinator.readOriginal(
          projectId,
          typeof request === "object" &&
            request !== null &&
            "requestId" in request &&
            typeof request.requestId === "string"
            ? request.requestId
            : "",
        );
        if (!original)
          throw new ConversationError(
            503,
            "The Fork original could not be read back; its identity remains unconfirmed.",
          );
        return forkMetadata(original);
      } catch (error) {
        if (error instanceof ConversationError) throw error;
        if (error instanceof CodexChatForkOriginalConflict)
          throw new ConversationError(
            409,
            "This Fork UUID belongs to another immutable source.",
          );
        if (error instanceof CodexChatForkJournalError)
          throw forkJournalFailure(error);
        throw new ConversationError(
          503,
          "The Codex Fork could not be safely verified; its original remains authoritative.",
        );
      }
    },
    readForkOriginal(projectId: string, requestId: string) {
      try {
        const original = forkCoordinator.readOriginal(projectId, requestId);
        if (!original)
          throw new ConversationError(
            404,
            "The exact Codex Fork original is not present in this trusted workspace.",
          );
        return forkMetadata(original);
      } catch (error) {
        if (error instanceof ConversationError) throw error;
        if (error instanceof CodexChatForkJournalError)
          throw forkJournalFailure(error);
        throw new ConversationError(
          503,
          "The private Codex Fork journal is unavailable.",
        );
      }
    },
    async listOperationIdentities(
      projectId: string,
    ): Promise<SessionOperationIdentityPage> {
      try {
        return await readSessionOperationIdentityPage({
          projectId,
          workspace,
          readStarts: async () =>
            (await identities.list(scopeFor(projectId))).map(metadata),
          readForks: async () =>
            forkCoordinator.listOriginals(projectId).map(forkMetadata),
        });
      } catch {
        throw new ConversationError(
          503,
          "The complete session operation identity page is unavailable.",
        );
      }
    },
    async retireIdentity(
      projectId: string,
      requestId: string,
      requestHash: string,
    ): Promise<SessionStartIdentityReply> {
      const scope = scopeFor(projectId);
      let row: RestartIdentityRow | null;
      try {
        row = await identities.lookup(scope, requestId);
      } catch {
        throw new ConversationError(
          503,
          "Session Start identities are unavailable.",
        );
      }
      if (row === null || row.requestHash !== requestHash)
        throw new ConversationError(
          409,
          "The Session Start identity does not match.",
        );
      if (row.state === "retired")
        return {
          version: 1,
          scope: publicScope(projectId),
          identity: metadata(row),
        };
      if (row.state !== "reserved")
        throw new ConversationError(
          409,
          "Only an unattempted Session Start identity can be retired.",
        );
      const identity: RestartIdentityInput = {
        version: row.version,
        address: row.address,
        workspace: row.workspace,
        requestId: row.requestId,
        requestHash: row.requestHash,
        provider: row.provider,
        mode: row.mode,
      };
      const source = verifyOriginal(identity);
      if (source.kind === "conflict") throw registryConflict();
      if (source.kind === "invalid") throw held();
      if (source.kind === "verified")
        throw new ConversationError(
          409,
          "A verified original Session Start cannot be retired.",
        );
      try {
        const retired = await identities.retireReserved(identity);
        return {
          version: 1,
          scope: publicScope(projectId),
          identity: metadata(retired),
        };
      } catch (error) {
        throw new ConversationError(
          error instanceof RestartIdentityJournalError &&
            error.kind === "conflict"
            ? 409
            : 503,
          error instanceof RestartIdentityJournalError &&
            error.kind === "conflict"
            ? "Only an unattempted Session Start identity can be retired."
            : "Session Start identities are unavailable.",
        );
      }
    },
    async start(projectId: string, raw: unknown) {
      const request = parseOwnedSessionStart(raw);
      const provider: RestartIdentityInput["provider"] =
        "provider" in request ? request.provider : "claude";
      const requestHash = createHash("sha256")
        .update(canonicalOwnedSessionStart(request))
        .digest("hex");
      const identity = {
        version: 1 as const,
        address: {
          family: "owned-session-start" as const,
          projectId,
        },
        workspace,
        requestId: request.requestId,
        requestHash,
        provider,
        mode: request.launch.mode,
      };
      const prior = await identities.lookup(
        { address: identity.address, workspace: identity.workspace },
        identity.requestId,
      );
      if (prior?.state === "retired")
        throw new ConversationError(
          409,
          "This Session Start identity has been retired and cannot be dispatched.",
        );
      if (prior !== null && prior.requestHash !== identity.requestHash)
        throw new ConversationError(
          409,
          "This Session Start UUID is already bound to another request.",
        );
      let source: ReturnType<typeof readVerifiedOriginalStart>;
      try {
        source = readVerifiedOriginalStart({
          home: options.home,
          root: options.root,
          identity,
        });
      } catch {
        throw held();
      }
      if (source.kind === "conflict") throw registryConflict();
      if (source.kind === "invalid") throw held();
      if (source.kind === "verified") {
        try {
          await identities.reserve(identity);
          if (prior === null || prior.state === "reserved")
            await identities.beginAttempt(identity);
          return (await identities.admit(identity)).evidence;
        } catch {
          throw held();
        }
      }
      if (
        prior === null ||
        prior.state === "reserved" ||
        prior.state === "not-sent"
      ) {
        await options.validateScope(
          projectId,
          {
            workspace: resolveCheckout(options.root).workspace,
            repository: request.repository,
            worktree: request.worktree,
            ...(request.beadId === undefined ? {} : { beadId: request.beadId }),
          },
          request.about ?? [],
          "provider" in request ? undefined : request.launch,
        );
      }
      await identities.reserve(identity);
      const claim = await identities.beginAttempt(identity);
      if (!claim.mayDispatch) {
        try {
          return (await identities.admit(identity)).evidence;
        } catch {
          throw held();
        }
      }
      if (source.kind !== "missing" && source.kind !== "empty") throw held();
      const attempt = createInitialStartAttempt(
        identity,
        claim.attemptGeneration,
        source.emptySource,
      );
      try {
        await dispatchStart(projectId, request, attempt);
      } catch (error) {
        const proof = proofForInitialStartRefusal(attempt);
        if (proof !== null) {
          try {
            await identities.settleNotSent(identity, proof);
          } catch {
            throw held();
          }
          throw error;
        }
        try {
          return (await identities.admit(identity)).evidence;
        } catch {
          throw held();
        }
      }
      try {
        return (await identities.admit(identity)).evidence;
      } catch {
        throw held();
      }
    },
    send(projectId: string, sessionId: string, input: SessionMessage) {
      return selected(projectId, sessionId).send(projectId, sessionId, input);
    },
    forkTurn(
      projectId: string,
      sessionId: string,
      input: SessionMessage,
      auditEventId: number,
    ) {
      if (!Number.isSafeInteger(auditEventId) || auditEventId <= 0)
        throw new ConversationError(
          503,
          "A confirmed operator audit receipt is required before a Fork child turn.",
        );
      const record = registry.lookup(projectId, sessionId);
      if (
        record.provider !== "codex" ||
        record.mode !== "chat" ||
        record.origin?.kind !== "codex-chat-fork"
      )
        throw new ConversationError(
          409,
          "Only a verified Codex Fork child accepts this continuation action.",
        );
      return chat.forkTurn(projectId, sessionId, input);
    },
    read(
      projectId: string,
      sessionId: string,
      query: { after?: number; limit?: number; requestId?: string } = {},
    ) {
      return selected(projectId, sessionId).read(projectId, sessionId, query);
    },
    list(projectId: string) {
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
