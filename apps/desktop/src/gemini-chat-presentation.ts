import type { ConversationPage } from "../../../types/conversation";
import type { GeminiChatPrivateFrame } from "../../../types/gemini-owned-chat";

export type GeminiChatPresentation =
  | { kind: "reply"; sequence: number; text: string; open: boolean }
  | {
      kind: "native-text";
      sequence: number;
      text: string;
      role: "assistant" | "user";
    }
  | {
      kind: "report";
      sequence: number;
      event: Exclude<GeminiChatPrivateFrame["event"], { kind: "text" }>;
    };

/** A journal turn is a capture boundary, never a native turn id for replayable ACP updates. */
export function geminiChatPresentation(
  page: ConversationPage | null,
  turnId: string,
): GeminiChatPresentation[] {
  const result: GeminiChatPresentation[] = [];
  let pending: Extract<GeminiChatPresentation, { kind: "reply" }> | null = null;
  for (const frame of page?.frames ?? []) {
    if (frame.turnId !== turnId || frame.event.kind !== "coding-gemini-chat") {
      pending = null;
      continue;
    }
    const event = frame.event.event;
    if (event.kind !== "text") {
      pending = null;
      if (
        "requestId" in event &&
        event.requestId !== null &&
        event.requestId !== turnId
      )
        continue;
      result.push({ kind: "report", sequence: frame.seq, event });
      continue;
    }
    if (!event.text) {
      pending = null;
      continue;
    }
    if (event.scope === "native-session" && event.requestId === null) {
      pending = null;
      // A replay may contain complete earlier messages, not just deltas. Keep each native update exact.
      result.push({
        kind: "native-text",
        sequence: frame.seq,
        text: event.text,
        role: event.role,
      });
    } else if (
      event.scope === "turn" &&
      event.requestId === turnId &&
      event.role === "assistant"
    ) {
      if (pending?.kind === "reply") pending.text += event.text;
      else {
        pending = {
          kind: "reply",
          sequence: frame.seq,
          text: event.text,
          open: false,
        };
        result.push(pending);
      }
    } else pending = null;
  }
  if (pending?.kind === "reply") pending.open = true;
  return result;
}

export function geminiChatOutcome(
  page: ConversationPage | null,
  turnId: string,
) {
  const frame = [...(page?.frames ?? [])]
    .reverse()
    .find(
      (item) =>
        item.turnId === turnId &&
        item.event.kind === "coding-gemini-chat" &&
        item.event.event.kind === "outcome",
    );
  return frame?.event.kind === "coding-gemini-chat" &&
    frame.event.event.kind === "outcome"
    ? frame.event.event
    : null;
}
