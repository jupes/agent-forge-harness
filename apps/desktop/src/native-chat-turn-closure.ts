import type { CodexChatEvent } from "../../../types/codex-chat";

/** Whether a supplied rich report is the final snapshot for this native turn. */
export function nativeChatTurnFinalReport(
  report: CodexChatEvent,
  threadId: string,
  turnId: string,
): boolean {
  if (
    !("threadId" in report) ||
    !("turnId" in report) ||
    report.threadId !== threadId ||
    report.turnId !== turnId
  )
    return false;
  if (
    report.kind === "command" ||
    report.kind === "file-change" ||
    report.kind === "mcp-tool-call" ||
    report.kind === "web-search"
  )
    return report.source === "turn/completed";
  return (
    report.kind === "reasoning-summary" &&
    report.update.kind === "snapshot" &&
    report.update.closure === "turn-ended"
  );
}
