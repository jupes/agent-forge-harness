import { createHash } from "node:crypto";
import type { OwnedCodingSessionRecord } from "../../../types/codex-owned-task";
import type { LedgerEventInput } from "../../../types/hearth";
import { createConversationStore } from "../../conversations/store";
import type { ConversationUpdate } from "../../conversations/transport";
import type { AppendResult } from "../../ledger/append";
import { serializeClaudeLaunch } from "../../sessions/claude-launch";
import { serializeCodexTask } from "../../sessions/codex-task";

/** Private transcript projection. No body or provider error is accepted by this ledger seam. */
export function createOwnedSessionLedger(
  home: string,
  deps: { appendEvent(event: LedgerEventInput): AppendResult },
) {
  const attempted = new Set<string>();
  return (
    session: OwnedCodingSessionRecord,
    update: ConversationUpdate,
  ): void => {
    const state = createConversationStore(home, undefined, {
      kind: "session",
      projectId: session.projectId,
      sessionId: session.id,
    }).read(session.projectId);
    const turn = state.turns.find(
      (item) => item.requestId === update.requestId,
    );
    if (
      !turn ||
      update.conversationId !== session.id ||
      update.projectId !== session.projectId
    )
      return;
    const user = state.frames.find(
      (frame) =>
        frame.turnId === update.requestId && frame.event.kind === "user",
    )?.event;
    const model = state.frames
      .filter(
        (frame) =>
          frame.turnId === update.requestId && frame.event.kind === "model",
      )
      .at(-1)?.event;
    const base = {
      workspace: session.workspace,
      sessionId: session.id,
      ...(session.beadId ? { beadId: session.beadId } : {}),
      ...(model?.kind === "model"
        ? {
            executor: {
              provider: session.provider,
              model: model.model,
              smith: session.smith,
              ...(state.binding ? { sessionId: state.binding.sessionId } : {}),
            },
          }
        : {}),
    };
    const emit = (key: string, event: LedgerEventInput) => {
      if (attempted.has(key)) return;
      attempted.add(key);
      deps.appendEvent(event);
    };
    const spawned = state.frames.some(
      (frame) =>
        frame.turnId === update.requestId && frame.event.kind === "process",
    );
    if (turn.phase === "running" && user?.kind === "user" && spawned) {
      const prompt = user.codexTask
        ? serializeCodexTask(user.codexTask.launch, user.codexTask.capabilities)
            .stdin
        : user.session
          ? serializeClaudeLaunch(
              user.session.launch,
              user.session.capabilities,
            ).stdin
          : user.text;
      if (state.turns[0]?.requestId === update.requestId)
        emit(`${session.id}:start`, {
          ...base,
          kind: "session.started",
          payload: {
            source: "desktop",
            kind: "headless",
            worktree: session.worktree,
          },
        });
      emit(`${session.id}:${turn.requestId}:prompt`, {
        ...base,
        kind: "prompt.submitted",
        payload: {
          hash: createHash("sha256").update(prompt).digest("hex"),
          length: prompt.length,
        },
      });
    }
    if (["completed", "cancelled", "failed", "unknown"].includes(turn.phase))
      emit(`${session.id}:${turn.requestId}:end`, {
        ...base,
        kind: "session.ended",
        payload: {
          reason: turn.phase,
          durationMs: Math.max(
            0,
            Date.parse(turn.updatedAt) - Date.parse(turn.createdAt),
          ),
        },
      });
  };
}
