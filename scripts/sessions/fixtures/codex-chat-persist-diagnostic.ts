import type { CodexChatEvent } from "../../../types/codex-chat";
import { ConversationError } from "../../conversations/error";

const eventKinds = [
  "identity",
  "configuration",
  "turn",
  "text",
  "command",
  "reasoning-summary",
  "turn-plan",
  "file-change",
  "mcp-tool-call",
  "web-search",
  "process",
  "reroute",
  "approval-request",
  "approval-decision",
  "approval-resolved",
  "usage",
  "outcome",
] as const satisfies readonly CodexChatEvent["kind"][];

export type CodexChatPersistFailureFact = {
  version: 1;
  phase: "event-persist";
  eventKind: CodexChatEvent["kind"] | "unavailable";
  completedPersistCallbacks: number;
  failureClass: "conversation-400" | "conversation-409" | "other";
};

export const CODEX_CHAT_PERSIST_FACT_MAX_BYTES = 512;

function classifyFailure(
  error: unknown,
): CodexChatPersistFailureFact["failureClass"] {
  if (!(error instanceof ConversationError)) return "other";
  if (error.status === 400) return "conversation-400";
  if (error.status === 409) return "conversation-409";
  return "other";
}

function eventKind(
  event: CodexChatEvent,
): CodexChatPersistFailureFact["eventKind"] {
  return eventKinds.includes(event.kind) ? event.kind : "unavailable";
}

/** Test-fixture-only observation wrapper. It never changes or retries persistence. */
export function observeCodexChatPersist<T>(options: {
  persist(event: CodexChatEvent): Promise<T>;
  recordFailure(fact: CodexChatPersistFailureFact): void;
}): (event: CodexChatEvent) => Promise<T> {
  let completedPersistCallbacks = 0,
    failureRecorded = false;
  return async (event) => {
    try {
      const result = await options.persist(event);
      completedPersistCallbacks = Math.min(completedPersistCallbacks + 1, 256);
      return result;
    } catch (error) {
      if (!failureRecorded) {
        failureRecorded = true;
        const fact: CodexChatPersistFailureFact = {
          version: 1,
          phase: "event-persist",
          eventKind: eventKind(event),
          completedPersistCallbacks,
          failureClass: classifyFailure(error),
        };
        if (
          Buffer.byteLength(JSON.stringify(fact), "utf8") <=
          CODEX_CHAT_PERSIST_FACT_MAX_BYTES
        ) {
          try {
            options.recordFailure(fact);
          } catch {
            // Diagnostics must never replace the original persistence error.
          }
        }
      }
      throw error;
    }
  };
}
