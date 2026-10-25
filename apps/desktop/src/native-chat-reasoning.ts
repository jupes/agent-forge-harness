import type { CodexChatReasoningSummary } from "../../../types/codex-chat";
import type { ConversationPage } from "../../../types/conversation";
import type { ReportedText } from "../../../types/session-activity";
import { nativeChatTurnFinalReport } from "./native-chat-turn-closure";

export type NativeChatSummarySnapshot = Extract<
  CodexChatReasoningSummary["update"],
  { kind: "snapshot" }
>;
export interface NativeChatSummaryPart {
  index: number;
  announced: boolean;
  content: ReportedText | null;
  prefixMissing: boolean;
}
export interface NativeChatReasoningReport {
  version: string;
  report: CodexChatReasoningSummary;
  initialSnapshot: NativeChatSummarySnapshot | null;
  itemSnapshot: NativeChatSummarySnapshot | null;
  turnSnapshot: NativeChatSummarySnapshot | null;
  parts: NativeChatSummaryPart[];
  earlierReportsMissing: boolean;
}

/** Supplied summaries only. A protected partial page does not establish an earlier stream prefix. */
export function nativeChatReasoningSummaries(
  page: ConversationPage | null,
  turnId: string,
): NativeChatReasoningReport[] {
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
  if (nativeTurns.size > 1) return [];
  const expectedTurn = [...nativeTurns][0];
  const reports = new Map<
    string,
    NativeChatReasoningReport & { indexed: Map<number, NativeChatSummaryPart> }
  >();
  let terminal = false,
    turnEnded = false;
  for (const { event } of frames) {
    if (event.kind !== "coding-chat" || event.version !== binding.version)
      continue;
    const report = event.event;
    if (
      report.kind === "outcome" &&
      report.outcome.threadId === binding.sessionId &&
      (!expectedTurn || report.outcome.turnId === expectedTurn)
    ) {
      terminal = true;
      continue;
    }
    const finalReport =
      expectedTurn !== undefined &&
      nativeChatTurnFinalReport(report, binding.sessionId, expectedTurn);
    if (finalReport) turnEnded = true;
    if (
      terminal ||
      (turnEnded && !finalReport) ||
      report.kind !== "reasoning-summary" ||
      report.threadId !== binding.sessionId ||
      (expectedTurn && report.turnId !== expectedTurn)
    )
      continue;
    const key = JSON.stringify([report.threadId, report.turnId, report.itemId]),
      previous = reports.get(key),
      update = report.update;
    if (
      previous?.turnSnapshot ||
      (previous?.itemSnapshot &&
        (update.kind !== "snapshot" ||
          update.closure !== "turn-ended" ||
          JSON.stringify([update.summary, update.truncated]) !==
            JSON.stringify([
              previous.itemSnapshot.summary,
              previous.itemSnapshot.truncated,
            ])))
    )
      continue;
    const current = previous ?? {
      version: event.version,
      report,
      initialSnapshot: null,
      itemSnapshot: null,
      turnSnapshot: null,
      parts: [],
      earlierReportsMissing: update.kind !== "snapshot",
      indexed: new Map<number, NativeChatSummaryPart>(),
    };
    if (update.kind === "snapshot") {
      if (update.closure === "open") current.initialSnapshot = update;
      else if (update.closure === "item-ended") current.itemSnapshot = update;
      else current.turnSnapshot = update;
    } else {
      const priorPart = current.indexed.get(update.summaryIndex),
        part = priorPart ?? {
          index: update.summaryIndex,
          announced: false,
          content: null,
          prefixMissing: update.kind === "delta",
        };
      if (update.kind === "part-added") part.announced = true;
      else if (!part.content?.truncated) {
        part.prefixMissing ||= update.prefixMissing;
        part.content = {
          text: (part.content?.text ?? "") + update.content.text,
          truncated: update.content.truncated,
        };
      }
      current.indexed.set(update.summaryIndex, part);
    }
    current.report = report;
    reports.set(key, current);
  }
  return [...reports.values()].map(({ indexed, ...report }) => ({
    ...report,
    // Arrival order is retained; an unannounced native index does not prove
    // where its missing prefix or any other reported part belongs.
    parts: [...indexed.values()],
  }));
}
