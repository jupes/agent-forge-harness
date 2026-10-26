/** Read-only proof that one exact completed app turn has sufficient native Fork source evidence. */
import type {
  CodexChatBinding,
  PreparedCodexChat,
} from "../../types/codex-chat";
import { workspaceKey } from "../projects/scope";
import { CODEX_APP_SERVER_VERSION } from "./codex-app-server-protocol";
import { ownedCodingStateSchema } from "./codex-owned-journal";

export type CodexChatForkSourceReason =
  | "invalid-state"
  | "scope-mismatch"
  | "binding-mismatch"
  | "turn-not-completed"
  | "source-incomplete"
  | "settings-mismatch"
  | "service-tier-unknown"
  | "approval-pending";

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
  state: unknown;
  projectId: string;
  conversationId: string;
  workspace: string;
  selectedTurnRequestId: string;
}): CodexChatForkSourceResult {
  const parsed = ownedCodingStateSchema.safeParse(input.state);
  if (!parsed.success) return { eligible: false, reason: "invalid-state" };
  const state = parsed.data;
  if (
    state.projectId !== input.projectId ||
    state.conversationId !== input.conversationId ||
    state.binding?.provider !== "codex" ||
    !state.binding.sessionId
  )
    return { eligible: false, reason: "scope-mismatch" };

  let requestedWorkspace: string, selectedTurns: typeof state.turns;
  try {
    requestedWorkspace = workspaceKey(input.workspace);
    selectedTurns = state.turns.filter(
      (turn) => turn.requestId === input.selectedTurnRequestId,
    );
  } catch {
    return { eligible: false, reason: "scope-mismatch" };
  }
  if (selectedTurns.length !== 1 || selectedTurns[0]?.phase !== "completed")
    return { eligible: false, reason: "turn-not-completed" };

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
  if (
    userFrames.length !== 1 ||
    userEvent?.kind !== "user" ||
    !("codexChat" in userEvent) ||
    !userEvent.codexChat ||
    !state.binding
  )
    return { eligible: false, reason: "source-incomplete" };

  const prepared = userEvent.codexChat,
    binding: CodexChatBinding = {
      provider: "codex",
      threadId: state.binding.sessionId,
      version: state.binding.version,
    };
  const context = prepared.launch.context;
  let preparedWorkspace: string;
  try {
    if (!context || context.projectId !== input.projectId || !context.worktree)
      return { eligible: false, reason: "scope-mismatch" };
    preparedWorkspace = workspaceKey(context.worktree);
  } catch {
    return { eligible: false, reason: "scope-mismatch" };
  }
  if (preparedWorkspace !== requestedWorkspace)
    return { eligible: false, reason: "scope-mismatch" };
  if (
    prepared.provider !== "codex" ||
    binding.version !== CODEX_APP_SERVER_VERSION ||
    prepared.capabilities.version !== CODEX_APP_SERVER_VERSION
  )
    return { eligible: false, reason: "binding-mismatch" };

  const identities = nativeEvents.filter((event) => event.kind === "identity"),
    configurations = nativeEvents.filter(
      (event) => event.kind === "configuration",
    ),
    turns = nativeEvents.filter((event) => event.kind === "turn"),
    outcomes = nativeEvents.filter((event) => event.kind === "outcome"),
    approvalRequests = nativeEvents
      .filter((event) => event.kind === "approval-request")
      .map((event) => event.approval.id),
    resolvedApprovals = new Set(
      nativeEvents
        .filter((event) => event.kind === "approval-resolved")
        .map((event) => event.approvalId),
    );
  if (
    approvalRequests.some((id) => !resolvedApprovals.has(id)) ||
    (approvalRequests.length > 0 && resolvedApprovals.size === 0)
  )
    return { eligible: false, reason: "approval-pending" };
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

  return {
    eligible: true,
    parent: binding,
    selectedTurnRequestId: input.selectedTurnRequestId,
    lastTurnId: turn.turnId,
    prepared,
    sourceSettings: {
      modelProvider: configuration.modelProvider,
      serviceTier: configuration.serviceTier,
      reasoningEffort: configuration.effort,
    },
  };
}
