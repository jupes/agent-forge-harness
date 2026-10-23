import type { ConversationPage } from "../../../types/conversation";
import type { GeminiTaskRuntimeEvent } from "../../../types/gemini-task-runtime";

export type GeminiTaskPresentation =
  | { kind: "reply"; sequence: number; text: string; open: boolean }
  | {
      kind: "report";
      sequence: number;
      event: Exclude<GeminiTaskRuntimeEvent, { kind: "text" }>;
    };

/** Local frame sequences key presentation only; the native reports have no message identity. */
export function geminiTaskPresentation(
  page: ConversationPage | null,
  turnId: string,
): GeminiTaskPresentation[] {
  const result: GeminiTaskPresentation[] = [];
  let pending: Extract<GeminiTaskPresentation, { kind: "reply" }> | null = null;
  for (const frame of page?.frames ?? []) {
    if (frame.turnId !== turnId || frame.event.kind !== "coding-gemini-task") {
      pending = null;
      continue;
    }
    const event = frame.event.event;
    if (event.kind !== "text") {
      pending = null;
      result.push({ kind: "report", sequence: frame.seq, event });
    } else if (event.delta && pending) pending.text += event.text;
    else {
      pending = null;
      if (!event.text) continue;
      const reply = {
        kind: "reply" as const,
        sequence: frame.seq,
        text: event.text,
        open: false,
      };
      result.push(reply);
      if (event.delta) pending = reply;
    }
  }
  if (pending) pending.open = true;
  return result;
}
