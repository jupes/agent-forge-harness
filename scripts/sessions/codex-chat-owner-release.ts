import { createHash } from "node:crypto";
import type { ConversationEvent } from "../../types/conversation";
import { workspaceKey } from "../projects/scope";
import { ownedCodingStateSchema } from "./codex-owned-journal";
import { codexChatOwnedSessionSchema } from "./codex-owned-metadata";
import { canonicalOwnedSessionStart } from "./codex-owned-protocol";

/** Internal read-only fold input; caller-derived scope is never accepted from a client. */
export interface CodexChatOwnerReleaseFoldInput {
  owner: unknown;
  state: unknown;
  projectId: string;
  conversationId: string;
  workspaceKey: string;
}

export type CodexChatOwnerReleaseFoldResult =
  | {
      eligible: true;
      turnRequestId: string;
      binding: {
        provider: "codex";
        sessionId: string;
        version: string;
        turnId: string;
      };
    }
  | {
      eligible: false;
      reason:
        | "invalid-owner"
        | "invalid-state"
        | "scope-mismatch"
        | "start-mismatch"
        | "turn-incomplete"
        | "turn-mismatch"
        | "conversation-active"
        | "approval-pending"
        | "release-missing"
        | "binding-mismatch";
    };

/**
 * Prove only the saved application/native release chain. This performs no IO,
 * scope discovery, provider checks, or dispatch and is not a launch authority.
 */
export function foldCodexChatOwnerRelease(
  input: CodexChatOwnerReleaseFoldInput,
): CodexChatOwnerReleaseFoldResult {
  const ownerParsed = codexChatOwnedSessionSchema.safeParse(input.owner);
  if (!ownerParsed.success || ownerParsed.data.origin)
    return { eligible: false, reason: "invalid-owner" };
  const owner = ownerParsed.data,
    stateParsed = ownedCodingStateSchema.safeParse(input.state);
  if (!stateParsed.success) return { eligible: false, reason: "invalid-state" };
  const state = stateParsed.data;
  let servedWorkspace: string, ownerWorkspace: string;
  try {
    servedWorkspace = workspaceKey(input.workspaceKey);
    ownerWorkspace = workspaceKey(owner.workspace);
  } catch {
    return { eligible: false, reason: "scope-mismatch" };
  }
  if (
    owner.provider !== "codex" ||
    owner.mode !== "chat" ||
    owner.projectId !== input.projectId ||
    owner.id !== input.conversationId ||
    ownerWorkspace !== servedWorkspace ||
    state.projectId !== owner.projectId ||
    state.conversationId !== owner.id ||
    state.binding?.provider !== "codex" ||
    !state.binding.sessionId ||
    !state.binding.version
  )
    return { eligible: false, reason: "scope-mismatch" };

  const startTurns = state.turns.filter(
      (turn) => turn.requestId === owner.requestId,
    ),
    startUsers = state.frames.filter(
      (frame) =>
        frame.turnId === owner.requestId && frame.event.kind === "user",
    );
  if (
    startTurns.length !== 1 ||
    startUsers.length !== 1 ||
    startUsers[0]?.event.kind !== "user" ||
    !("codexChat" in startUsers[0].event) ||
    !startUsers[0].event.codexChat ||
    startUsers[0].event.codexChat.launch.mode !== "chat" ||
    !startTurns[0] ||
    !matchesTurnHash(startTurns[0].hash, startUsers[0].event) ||
    !matchesOwnerStart(owner, startUsers[0].event)
  )
    return { eligible: false, reason: "start-mismatch" };

  const userSequenceByTurn = new Map<string, number>();
  for (const frame of state.frames) {
    if (frame.event.kind !== "user") continue;
    if (userSequenceByTurn.has(frame.turnId))
      return { eligible: false, reason: "turn-mismatch" };
    userSequenceByTurn.set(frame.turnId, frame.seq);
  }
  let previousUserSequence = 0;
  for (const turn of state.turns) {
    const userSequence = userSequenceByTurn.get(turn.requestId);
    if (userSequence === undefined || userSequence <= previousUserSequence)
      return { eligible: false, reason: "turn-mismatch" };
    previousUserSequence = userSequence;
  }
  if (userSequenceByTurn.size !== state.turns.length)
    return { eligible: false, reason: "turn-mismatch" };
  const latest = state.turns.at(-1);
  if (!latest || latest.phase !== "completed")
    return { eligible: false, reason: "turn-incomplete" };
  if (
    state.turns.filter((turn) => turn.requestId === latest.requestId).length !==
    1
  )
    return { eligible: false, reason: "turn-mismatch" };
  if (
    state.turns.some(
      (turn) =>
        ["accepted", "running", "cancelling", "unknown"].includes(turn.phase) &&
        turn.requestId !== latest.requestId,
    )
  )
    return { eligible: false, reason: "conversation-active" };

  const turnUsers = state.frames.filter(
    (frame) => frame.turnId === latest.requestId && frame.event.kind === "user",
  );
  if (
    turnUsers.length !== 1 ||
    turnUsers[0]?.event.kind !== "user" ||
    !("codexChat" in turnUsers[0].event) ||
    !turnUsers[0].event.codexChat ||
    turnUsers[0].event.codexChat.launch.mode !== "chat" ||
    turnUsers[0].event.codexChat.capabilities.version !==
      state.binding.version ||
    !matchesTurnHash(latest.hash, turnUsers[0].event) ||
    !matchesTurnScope(turnUsers[0].event, owner, input.projectId)
  )
    return { eligible: false, reason: "turn-mismatch" };

  const outstanding = new Set<string>();
  for (const frame of state.frames) {
    if (frame.event.kind !== "coding-chat" || frame.event.provider !== "codex")
      continue;
    const event = frame.event.event,
      key = `${frame.turnId}\0`;
    if (event.kind === "approval-request")
      outstanding.add(`${key}${event.approval.id}`);
    else if (event.kind === "approval-resolved")
      outstanding.delete(`${key}${event.approvalId}`);
  }
  if (outstanding.size > 0)
    return { eligible: false, reason: "approval-pending" };

  const lifecycle = state.codexChatOwnerLifecycle ?? [],
    starts = lifecycle.filter(
      (fact) =>
        fact.kind === "generation-started" &&
        fact.requestId === latest.requestId,
    ),
    releases = lifecycle.filter(
      (fact) =>
        fact.kind === "generation-released" &&
        fact.requestId === latest.requestId,
    );
  if (starts.length !== 1 || releases.length !== 1)
    return { eligible: false, reason: "release-missing" };
  const started = starts[0],
    released = releases[0];
  if (
    !started ||
    started.kind !== "generation-started" ||
    !released ||
    released.kind !== "generation-released" ||
    started.generationId !== released.generationId ||
    released.binding.provider !== "codex" ||
    released.binding.sessionId !== state.binding.sessionId ||
    released.binding.version !== state.binding.version
  )
    return { eligible: false, reason: "binding-mismatch" };

  const turnFrames = state.frames.filter(
      (frame) => frame.turnId === latest.requestId,
    ),
    identities = turnFrames.filter((frame) => frame.event.kind === "identity"),
    nativeTurns = turnFrames.filter(
      (frame) =>
        frame.event.kind === "coding-chat" &&
        frame.event.provider === "codex" &&
        frame.event.event.kind === "turn",
    ),
    nativeOutcomes = turnFrames.filter(
      (frame) =>
        frame.event.kind === "coding-chat" &&
        frame.event.provider === "codex" &&
        frame.event.event.kind === "outcome",
    );
  if (
    identities.length !== 1 ||
    nativeTurns.length !== 1 ||
    nativeOutcomes.length !== 1
  )
    return { eligible: false, reason: "binding-mismatch" };
  const identity = identities[0]?.event,
    nativeTurn = nativeTurns[0]?.event,
    nativeOutcome = nativeOutcomes[0]?.event,
    identityFrame = identities[0],
    nativeTurnFrame = nativeTurns[0],
    nativeOutcomeFrame = nativeOutcomes[0];
  if (
    identity?.kind !== "identity" ||
    identity.provider !== "codex" ||
    identity.sessionId !== released.binding.sessionId ||
    identity.version !== released.binding.version ||
    nativeTurn?.kind !== "coding-chat" ||
    nativeTurn.event.kind !== "turn" ||
    nativeTurn.version !== released.binding.version ||
    nativeTurn.event.threadId !== released.binding.sessionId ||
    nativeTurn.event.turnId !== released.binding.turnId ||
    nativeOutcome?.kind !== "coding-chat" ||
    nativeOutcome.event.kind !== "outcome" ||
    nativeOutcome.version !== released.binding.version ||
    nativeOutcome.event.outcome.threadId !== released.binding.sessionId ||
    nativeOutcome.event.outcome.turnId !== released.binding.turnId ||
    nativeOutcome.event.outcome.phase !== "completed" ||
    nativeOutcome.event.outcome.exitCode !== 0 ||
    nativeOutcome.event.outcome.stopped ||
    nativeOutcome.event.outcome.timedOut ||
    !identityFrame ||
    !nativeTurnFrame ||
    !nativeOutcomeFrame ||
    started.afterSequence > identityFrame.seq - 1 ||
    released.afterSequence < identityFrame.seq ||
    released.afterSequence < nativeTurnFrame.seq ||
    released.afterSequence >= nativeOutcomeFrame.seq ||
    released.revision >= state.revision ||
    turnFrames.some(
      (frame) =>
        frame.seq > released.afterSequence && frame !== nativeOutcomeFrame,
    )
  )
    return { eligible: false, reason: "binding-mismatch" };

  return {
    eligible: true,
    turnRequestId: latest.requestId,
    binding: {
      provider: "codex",
      sessionId: released.binding.sessionId,
      version: released.binding.version,
      turnId: released.binding.turnId,
    },
  };
}

function matchesOwnerStart(
  owner: {
    requestId: string;
    requestHash: string;
    provider: "codex";
    projectId: string;
    smith: string;
    repository: string;
    worktree: string;
    requestedModel: string;
    requestedEffort: string | null;
    beadId?: string | undefined;
  },
  event: Extract<ConversationEvent, { kind: "user" }>,
): boolean {
  if (!("codexChat" in event)) return false;
  const prepared = event.codexChat;
  if (!prepared || prepared.launch.mode !== "chat") return false;
  try {
    if (
      prepared.smith !== owner.smith ||
      prepared.launch.model !== owner.requestedModel ||
      (prepared.launch.effort ?? null) !== owner.requestedEffort ||
      workspaceKey(prepared.cwd) !== workspaceKey(owner.worktree) ||
      prepared.launch.context?.projectId !== owner.projectId ||
      workspaceKey(prepared.launch.context?.repository ?? "") !==
        workspaceKey(owner.repository) ||
      workspaceKey(prepared.launch.context?.worktree ?? "") !==
        workspaceKey(owner.worktree) ||
      (prepared.launch.context?.beadId ?? null) !== (owner.beadId ?? null) ||
      JSON.stringify(prepared.launch.context?.about ?? []) !==
        JSON.stringify(event.about ?? [])
    )
      return false;
  } catch {
    return false;
  }
  const { cwd: _cwd, context: _context, ...launch } = prepared.launch,
    request = {
      requestId: owner.requestId,
      provider: "codex" as const,
      smith: owner.smith,
      repository: owner.repository,
      worktree: owner.worktree,
      ...(owner.beadId ? { beadId: owner.beadId } : {}),
      launch,
    };
  try {
    return [request, { ...request, about: event.about }].some(
      (candidate) =>
        createHash("sha256")
          .update(canonicalOwnedSessionStart(candidate))
          .digest("hex") === owner.requestHash,
    );
  } catch {
    return false;
  }
}

function matchesTurnHash(
  expected: string,
  event: Extract<ConversationEvent, { kind: "user" }>,
): boolean {
  if (!("codexChat" in event)) return false;
  if (!event.codexChat) return false;
  try {
    return (
      createHash("sha256")
        .update(
          JSON.stringify({
            text: event.text,
            about: event.about,
            codexChat: event.codexChat,
          }),
        )
        .digest("hex") === expected
    );
  } catch {
    return false;
  }
}

function matchesTurnScope(
  event: Extract<ConversationEvent, { kind: "user" }>,
  owner: {
    projectId: string;
    smith: string;
    repository: string;
    worktree: string;
    beadId?: string | undefined;
  },
  projectId: string,
): boolean {
  if (!("codexChat" in event)) return false;
  const prepared = event.codexChat,
    context = prepared?.launch.context;
  if (
    !prepared ||
    prepared.smith !== owner.smith ||
    !context ||
    context.projectId !== projectId ||
    context.projectId !== owner.projectId
  )
    return false;
  try {
    return (
      workspaceKey(context.repository) === workspaceKey(owner.repository) &&
      workspaceKey(context.worktree) === workspaceKey(owner.worktree) &&
      workspaceKey(prepared.cwd) === workspaceKey(owner.worktree) &&
      (context.beadId ?? null) === (owner.beadId ?? null) &&
      JSON.stringify(context.about ?? []) === JSON.stringify(event.about ?? [])
    );
  } catch {
    return false;
  }
}
