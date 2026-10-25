import type { CodexChatFileChange } from "../../../types/codex-chat";
import type { ConversationPage } from "../../../types/conversation";
import { nativeChatTurnFinalReport } from "./native-chat-turn-closure";

export interface NativeChatFileChangeReport {
  version: string;
  report: CodexChatFileChange;
}

/** Each native patch report is a complete replacement, never a patch to the local filesystem. */
export function nativeChatFileChanges(
  page: ConversationPage | null,
  turnId: string,
): NativeChatFileChangeReport[] {
  if (page?.binding?.provider !== "codex") return [];
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
  // A protected partial page may omit the earlier turn announcement. Its full
  // rich snapshots can stand alone only when all supplied native turns agree.
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
  if (nativeTurns.size !== 1) return [];
  const nativeTurn = nativeTurns.values().next().value;
  if (nativeTurn === undefined) return [];
  const reports = new Map<string, NativeChatFileChangeReport>();
  let terminal = false,
    turnEnded = false;
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
    const finalReport = nativeChatTurnFinalReport(
      report,
      binding.sessionId,
      nativeTurn,
    );
    if (finalReport) turnEnded = true;
    if (
      terminal ||
      (turnEnded && !finalReport) ||
      report.kind !== "file-change" ||
      report.threadId !== binding.sessionId ||
      report.turnId !== nativeTurn
    )
      continue;
    const key = JSON.stringify([report.threadId, report.turnId, report.itemId]),
      previous = reports.get(key)?.report;
    if (
      previous?.closure === "turn-ended" ||
      (previous?.closure === "item-ended" &&
        (report.closure !== "turn-ended" ||
          JSON.stringify([report.status, report.changes, report.truncated]) !==
            JSON.stringify([
              previous.status,
              previous.changes,
              previous.truncated,
            ])))
    )
      continue;
    reports.set(key, { version: event.version, report });
  }
  return [...reports.values()];
}
