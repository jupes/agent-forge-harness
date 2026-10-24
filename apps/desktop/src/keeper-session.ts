import type {
  ConversationPage,
  ConversationPhase,
} from "../../../types/conversation";

export interface KeeperSessionSelection {
  sessionId: string;
  requestId: string;
}
export interface KeeperSession extends KeeperSessionSelection {
  provider: string;
  phase: ConversationPhase;
  createdAt: string;
  updatedAt: string;
  canStop: boolean;
  reason: string | null;
}

/** The private feed proves current-turn identity; ledger observations grant no control. */
export function keeperSession(
  projectId: string,
  page: ConversationPage | null,
): KeeperSession | null {
  if (!page || page.projectId !== projectId || !page.binding) return null;
  const turn = page.turns.at(-1),
    binding = page.binding;
  if (
    !turn ||
    !page.frames.some(
      (frame) =>
        frame.turnId === turn.requestId &&
        frame.event.kind === "identity" &&
        frame.event.provider === binding.provider &&
        frame.event.sessionId === binding.sessionId,
    )
  )
    return null;
  const active = ["accepted", "running", "cancelling"].includes(turn.phase);
  return {
    sessionId: binding.sessionId,
    requestId: turn.requestId,
    provider: binding.provider,
    phase: turn.phase,
    createdAt: turn.createdAt,
    updatedAt: turn.updatedAt,
    canStop: page.controllable && ["accepted", "running"].includes(turn.phase),
    reason: !active
      ? turn.phase === "unknown"
        ? "Completion is unknown; this read cannot confirm a controllable process."
        : "This turn has ended."
      : !page.controllable
        ? "This hearth does not own the process."
        : turn.phase === "cancelling"
          ? "Stop is pending confirmation."
          : null,
  };
}
