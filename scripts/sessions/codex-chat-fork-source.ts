/** Read-only proof that one exact completed app turn has sufficient native Fork source evidence. */
import { createHash } from "node:crypto";
import type {
  CodexChatBinding,
  PreparedCodexChat,
} from "../../types/codex-chat";
import type { CodexChatOwnedRecord } from "../../types/codex-owned-chat";
import type { ConversationEvent } from "../../types/conversation";
import { workspaceKey } from "../projects/scope";
import { CODEX_APP_SERVER_VERSION } from "./codex-app-server-protocol";
import { parseCodexChatForkRuntimeInput } from "./codex-chat-fork-runtime-protocol";
import { ownedCodingStateSchema } from "./codex-owned-journal";
import { codexChatOwnedSessionSchema } from "./codex-owned-metadata";
import { canonicalOwnedSessionStart } from "./codex-owned-protocol";

export type CodexChatForkSourceReason =
  | "invalid-state"
  | "scope-mismatch"
  | "owner-mismatch"
  | "turn-hash-mismatch"
  | "binding-mismatch"
  | "turn-not-completed"
  | "conversation-active"
  | "source-incomplete"
  | "settings-mismatch"
  | "service-tier-unknown"
  | "approval-pending"
  | "unsupported-source";

export type CodexChatForkSourceResult =
  | {
      eligible: true;
      parent: CodexChatBinding;
      selectedTurnRequestId: string;
      lastTurnId: string;
      prepared: PreparedCodexChat;
      sourceSettings: {
        modelProvider: string;
        serviceTier: string | null;
        reasoningEffort: string | null;
      };
    }
  | { eligible: false; reason: CodexChatForkSourceReason };

/**
 * Resolve only an exact app-owned completed turn from its complete saved state.
 * This performs no filesystem reads, provider calls, writes, or process checks;
 * a successful result is evidence only and does not authorize a native Fork.
 */
export function resolveCodexChatForkSource(input: {
  owner: unknown;
  state: unknown;
  projectId: string;
  conversationId: string;
  /** The server-derived workspace key for the currently served hearth root. */
  workspaceKey: string;
  selectedTurnRequestId: string;
}): CodexChatForkSourceResult {
  const parsedOwner = codexChatOwnedSessionSchema.safeParse(input.owner);
  if (!parsedOwner.success)
    return { eligible: false, reason: "owner-mismatch" };
  const owner: CodexChatOwnedRecord = parsedOwner.data;
  const parsed = ownedCodingStateSchema.safeParse(input.state);
  if (!parsed.success) return { eligible: false, reason: "invalid-state" };
  const state = parsed.data;
  if (
    owner.provider !== "codex" ||
    owner.mode !== "chat" ||
    owner.projectId !== input.projectId ||
    owner.id !== input.conversationId ||
    state.projectId !== owner.projectId ||
    state.conversationId !== owner.id ||
    state.binding?.provider !== "codex" ||
    !state.binding.sessionId
  )
    return { eligible: false, reason: "scope-mismatch" };

  let servedWorkspace: string, originalWorkspace: string;
  try {
    servedWorkspace = workspaceKey(input.workspaceKey);
    originalWorkspace = workspaceKey(owner.workspace);
  } catch {
    return { eligible: false, reason: "scope-mismatch" };
  }
  if (servedWorkspace !== originalWorkspace)
    return { eligible: false, reason: "scope-mismatch" };

  const selectedTurns = state.turns.filter(
    (turn) => turn.requestId === input.selectedTurnRequestId,
  );
  if (selectedTurns.length !== 1 || selectedTurns[0]?.phase !== "completed")
    return { eligible: false, reason: "turn-not-completed" };
  const selectedTurn = selectedTurns[0];
  if (!selectedTurn) return { eligible: false, reason: "turn-not-completed" };
  if (
    state.turns.some(
      (turn) =>
        turn.requestId !== input.selectedTurnRequestId &&
        ["accepted", "running", "cancelling", "unknown"].includes(turn.phase),
    )
  )
    return { eligible: false, reason: "conversation-active" };

  const unresolvedApprovals = new Set<string>();
  for (const frame of state.frames) {
    if (frame.event.kind !== "coding-chat" || frame.event.provider !== "codex")
      continue;
    const native = frame.event.event,
      key = `${frame.turnId}\0`;
    if (native.kind === "approval-request")
      unresolvedApprovals.add(`${key}${native.approval.id}`);
    else if (native.kind === "approval-resolved")
      unresolvedApprovals.delete(`${key}${native.approvalId}`);
  }
  if (unresolvedApprovals.size > 0)
    return { eligible: false, reason: "approval-pending" };

  const frames = state.frames.filter(
      (frame) => frame.turnId === input.selectedTurnRequestId,
    ),
    userFrames = frames.filter((frame) => frame.event.kind === "user"),
    nativeEvents = frames.flatMap((frame) =>
      frame.event.kind === "coding-chat" && frame.event.provider === "codex"
        ? [frame.event.event]
        : [],
    );
  const userEvent = userFrames[0]?.event;
  if (userFrames.length !== 1 || userEvent?.kind !== "user")
    return { eligible: false, reason: "source-incomplete" };
  if (!("codexChat" in userEvent) || !userEvent.codexChat)
    return { eligible: false, reason: "source-incomplete" };
  if (!state.binding) return { eligible: false, reason: "binding-mismatch" };

  const prepared = userEvent.codexChat,
    binding: CodexChatBinding = {
      provider: "codex",
      threadId: state.binding.sessionId,
      version: state.binding.version,
    };
  if (!matchesSavedTurnHash(selectedTurn.hash, userEvent, prepared))
    return { eligible: false, reason: "turn-hash-mismatch" };
  const context = prepared.launch.context;
  const originalFrames = state.frames.filter(
      (frame) =>
        frame.turnId === owner.requestId && frame.event.kind === "user",
    ),
    originalUser = originalFrames[0]?.event;
  if (
    originalFrames.length !== 1 ||
    originalUser?.kind !== "user" ||
    !("codexChat" in originalUser) ||
    !originalUser.codexChat
  )
    return { eligible: false, reason: "owner-mismatch" };
  const originalPrepared = originalUser.codexChat;
  if (
    !matchesOriginalStart(owner, originalPrepared, originalUser.about) ||
    originalPrepared.smith !== owner.smith ||
    originalPrepared.launch.model !== owner.requestedModel ||
    (originalPrepared.launch.effort ?? null) !== owner.requestedEffort ||
    workspaceKey(originalPrepared.cwd) !== workspaceKey(owner.worktree) ||
    originalPrepared.launch.context?.projectId !== owner.projectId ||
    workspaceKey(originalPrepared.launch.context?.repository ?? "") !==
      workspaceKey(owner.repository) ||
    workspaceKey(originalPrepared.launch.context?.worktree ?? "") !==
      workspaceKey(owner.worktree) ||
    (originalPrepared.launch.context?.beadId ?? null) !== (owner.beadId ?? null)
  )
    return { eligible: false, reason: "owner-mismatch" };

  if (!context) return { eligible: false, reason: "settings-mismatch" };
  try {
    if (
      prepared.smith !== owner.smith ||
      prepared.launch.model !== owner.requestedModel ||
      (prepared.launch.effort ?? null) !== owner.requestedEffort ||
      prepared.canonicalCwd !== originalPrepared.canonicalCwd ||
      prepared.launch.sandbox !== originalPrepared.launch.sandbox ||
      prepared.launch.approvalPolicy !==
        originalPrepared.launch.approvalPolicy ||
      prepared.capabilities.version !== originalPrepared.capabilities.version ||
      workspaceKey(prepared.cwd) !== workspaceKey(owner.worktree) ||
      context.projectId !== owner.projectId ||
      workspaceKey(context.repository) !== workspaceKey(owner.repository) ||
      workspaceKey(context.worktree) !== workspaceKey(owner.worktree) ||
      (context.beadId ?? null) !== (owner.beadId ?? null)
    )
      return { eligible: false, reason: "settings-mismatch" };
  } catch {
    return { eligible: false, reason: "settings-mismatch" };
  }
  if (
    binding.version !== CODEX_APP_SERVER_VERSION ||
    prepared.capabilities.version !== CODEX_APP_SERVER_VERSION
  )
    return { eligible: false, reason: "binding-mismatch" };

  const identities = nativeEvents.filter((event) => event.kind === "identity"),
    configurations = nativeEvents.filter(
      (event) => event.kind === "configuration",
    ),
    turns = nativeEvents.filter((event) => event.kind === "turn"),
    outcomes = nativeEvents.filter((event) => event.kind === "outcome");
  if (
    identities.length !== 1 ||
    configurations.length !== 1 ||
    turns.length !== 1 ||
    outcomes.length !== 1
  )
    return { eligible: false, reason: "source-incomplete" };

  const identity = identities[0],
    configuration = configurations[0],
    turn = turns[0],
    outcome = outcomes[0];
  if (
    !identity ||
    !configuration ||
    !turn ||
    !outcome ||
    identity.kind !== "identity" ||
    configuration.kind !== "configuration" ||
    turn.kind !== "turn" ||
    outcome.kind !== "outcome"
  )
    return { eligible: false, reason: "source-incomplete" };
  if (
    identity.threadId !== binding.threadId ||
    identity.version !== binding.version ||
    turn.threadId !== binding.threadId ||
    outcome.outcome.threadId !== binding.threadId ||
    outcome.outcome.turnId !== turn.turnId ||
    outcome.outcome.phase !== "completed"
  )
    return { eligible: false, reason: "binding-mismatch" };
  if (
    configuration.model !== prepared.launch.model ||
    configuration.cwd !== prepared.cwd ||
    (prepared.launch.effort !== undefined &&
      configuration.effort !== prepared.launch.effort)
  )
    return { eligible: false, reason: "settings-mismatch" };
  if (
    !Object.hasOwn(configuration, "serviceTier") ||
    configuration.serviceTier === undefined
  )
    return { eligible: false, reason: "service-tier-unknown" };

  const runtimeInput = {
    prepared,
    parent: binding,
    lastTurnId: turn.turnId,
    sourceSettings: {
      modelProvider: configuration.modelProvider,
      serviceTier: configuration.serviceTier,
      reasoningEffort: configuration.effort,
    },
  };
  let checkedRuntimeInput: ReturnType<typeof parseCodexChatForkRuntimeInput>;
  try {
    checkedRuntimeInput = parseCodexChatForkRuntimeInput(runtimeInput);
  } catch {
    return { eligible: false, reason: "unsupported-source" };
  }

  return {
    eligible: true,
    parent: checkedRuntimeInput.parent,
    selectedTurnRequestId: input.selectedTurnRequestId,
    lastTurnId: checkedRuntimeInput.lastTurnId,
    prepared: checkedRuntimeInput.prepared,
    sourceSettings: checkedRuntimeInput.sourceSettings,
  };
}

function matchesOriginalStart(
  owner: CodexChatOwnedRecord,
  prepared: PreparedCodexChat,
  about: Array<{ kind: "bead" | "session" | "run" | "event"; id: string }>,
): boolean {
  const { cwd: _cwd, context: _context, ...launch } = prepared.launch;
  const request = {
    requestId: owner.requestId,
    provider: "codex" as const,
    smith: owner.smith,
    repository: owner.repository,
    worktree: owner.worktree,
    ...(owner.beadId ? { beadId: owner.beadId } : {}),
    launch,
  };
  try {
    for (const candidate of [request, { ...request, about }]) {
      const hash = createHash("sha256")
        .update(canonicalOwnedSessionStart(candidate))
        .digest("hex");
      if (hash === owner.requestHash) return true;
    }
  } catch {
    return false;
  }
  return false;
}

function matchesSavedTurnHash(
  expected: string,
  user: Extract<ConversationEvent, { kind: "user" }>,
  prepared: PreparedCodexChat,
): boolean {
  return (
    createHash("sha256")
      .update(
        JSON.stringify({
          text: user.text,
          about: user.about,
          codexChat: prepared,
        }),
      )
      .digest("hex") === expected
  );
}
