import type { CodexChatTurnPlan } from "../../../types/codex-chat";
import type { ConversationPage } from "../../../types/conversation";
import { nativeChatTurnFinalReport } from "./native-chat-turn-closure";

export interface NativeChatTurnPlanReport {
  version: string;
  report: CodexChatTurnPlan;
}

/** A supplied replacement snapshot is inert data, not a lifecycle or permission signal. */
export function nativeChatTurnPlan(
  page: ConversationPage | null,
  turnId: string,
): NativeChatTurnPlanReport | null {
  if (page?.binding?.provider !== "codex") return null;
  const binding = page.binding,
    frames = page.frames.filter((frame) => frame.turnId === turnId),
    nativeTurns = new Set(
      frames.flatMap(({ event }) =>
        event.kind === "coding-chat" &&
        event.version === binding.version &&
        event.event.kind === "turn" &&
        event.event.threadId === binding.sessionId
          ? [event.event.turnId]
          : [],
      ),
    );
  // A protected partial page can omit the earlier native-turn frame. Its rich
  // replacement snapshots are complete reports, but cannot disagree on scope.
  if (!nativeTurns.size)
    for (const { event } of frames)
      if (
        event.kind === "coding-chat" &&
        event.version === binding.version &&
        (event.event.kind === "command" ||
          event.event.kind === "file-change" ||
          event.event.kind === "reasoning-summary" ||
          event.event.kind === "turn-plan" ||
          event.event.kind === "mcp-tool-call" ||
          event.event.kind === "web-search") &&
        event.event.threadId === binding.sessionId
      )
        nativeTurns.add(event.event.turnId);
  if (nativeTurns.size !== 1) return null;
  const nativeTurn = nativeTurns.values().next().value;
  if (nativeTurn === undefined) return null;
  let latest: NativeChatTurnPlanReport | null = null,
    terminal = false;
  for (const { event } of frames) {
    if (event.kind !== "coding-chat" || event.version !== binding.version)
      continue;
    const report = event.event;
    if (
      report.kind === "outcome" &&
      (report.outcome.threadId === null ||
        report.outcome.threadId === binding.sessionId) &&
      (report.outcome.turnId === null || report.outcome.turnId === nativeTurn)
    ) {
      terminal = true;
      continue;
    }
    if (nativeChatTurnFinalReport(report, binding.sessionId, nativeTurn)) {
      terminal = true;
      continue;
    }
    if (
      !terminal &&
      report.kind === "turn-plan" &&
      report.threadId === binding.sessionId &&
      report.turnId === nativeTurn
    )
      latest = { version: event.version, report };
  }
  return latest;
}
