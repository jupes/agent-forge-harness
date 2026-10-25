import type { CodexChatWebSearch } from "../../../types/codex-chat";
import type { ConversationPage } from "../../../types/conversation";

export interface NativeChatWebSearchReport {
  version: string;
  report: CodexChatWebSearch;
}

/** Native web-search reports stay inert; this projection grants no fetch or link authority. */
export function nativeChatWebSearches(
  page: ConversationPage | null,
  turnId: string,
): NativeChatWebSearchReport[] {
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
  // Protected partial pages may begin with the full native snapshot and omit its turn announcement.
  if (!nativeTurns.size)
    for (const { event } of frames)
      if (
        event.kind === "coding-chat" &&
        event.version === binding.version &&
        event.event.kind === "web-search" &&
        event.event.threadId === binding.sessionId
      )
        nativeTurns.add(event.event.turnId);
  if (nativeTurns.size !== 1) return [];
  const nativeTurn = [...nativeTurns][0],
    reports = new Map<string, NativeChatWebSearchReport>();
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
    const finalReport =
      (report.kind === "command" ||
        report.kind === "file-change" ||
        report.kind === "reasoning-summary" ||
        report.kind === "mcp-tool-call" ||
        report.kind === "web-search") &&
      report.source === "turn/completed" &&
      report.threadId === binding.sessionId &&
      report.turnId === nativeTurn;
    if (finalReport) turnEnded = true;
    if (
      terminal ||
      (turnEnded && !finalReport) ||
      report.kind !== "web-search" ||
      report.threadId !== binding.sessionId ||
      report.turnId !== nativeTurn
    )
      continue;
    const previous = reports.get(report.itemId)?.report;
    if (
      previous?.closure === "turn-ended" ||
      (previous?.closure === "item-ended" &&
        (report.closure !== "turn-ended" ||
          JSON.stringify([
            previous.query,
            previous.action,
            previous.results,
          ]) !== JSON.stringify([report.query, report.action, report.results])))
    )
      continue;
    reports.set(report.itemId, { version: event.version, report });
  }
  return [...reports.values()];
}
