import type { CodexChatMcpToolCall } from "../../../types/codex-chat";
import type { ConversationPage } from "../../../types/conversation";

export interface NativeChatMcpToolCallReport {
  version: string;
  report: CodexChatMcpToolCall;
}

/** Native MCP snapshots are inert reports and never expose app, plugin or resource hints. */
export function nativeChatMcpToolCalls(
  page: ConversationPage | null,
  turnId: string,
): NativeChatMcpToolCallReport[] {
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
  // Protected partial pages may start at a full item snapshot without its turn announcement.
  if (!nativeTurns.size)
    for (const { event } of frames)
      if (
        event.kind === "coding-chat" &&
        event.version === binding.version &&
        event.event.kind === "mcp-tool-call" &&
        event.event.threadId === binding.sessionId
      )
        nativeTurns.add(event.event.turnId);
  if (nativeTurns.size !== 1) return [];
  const nativeTurn = [...nativeTurns][0],
    reports = new Map<string, NativeChatMcpToolCallReport>();
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
        report.kind === "mcp-tool-call") &&
      report.source === "turn/completed" &&
      report.threadId === binding.sessionId &&
      report.turnId === nativeTurn;
    if (finalReport) turnEnded = true;
    if (
      terminal ||
      (turnEnded && !finalReport) ||
      report.kind !== "mcp-tool-call" ||
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
          JSON.stringify([
            report.server,
            report.tool,
            report.arguments,
            report.status,
            report.result,
            report.error,
            report.durationMs,
          ]) !==
            JSON.stringify([
              previous.server,
              previous.tool,
              previous.arguments,
              previous.status,
              previous.result,
              previous.error,
              previous.durationMs,
            ])))
    )
      continue;
    reports.set(key, { version: event.version, report });
  }
  return [...reports.values()];
}
