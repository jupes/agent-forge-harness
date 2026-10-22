import type {
  ConversationEvent,
  ConversationObject,
  ConversationPage,
  ConversationTurn,
} from "../../../types/conversation";

export interface KeeperTurnView {
  id: string;
  at: string;
  question: string;
  about: ConversationObject[];
  reply: string;
  reads: Extract<ConversationEvent, { kind: "read" }>[];
  turn: ConversationTurn | null;
}
export function keeperTurns(page: ConversationPage | null): KeeperTurnView[] {
  const rows = new Map<string, KeeperTurnView>();
  for (const frame of page?.frames ?? []) {
    let row = rows.get(frame.turnId);
    if (!row) {
      row = {
        id: frame.turnId,
        at: frame.at,
        question: "",
        about: [],
        reply: "",
        reads: [],
        turn:
          page?.turns.find((turn) => turn.requestId === frame.turnId) ?? null,
      };
      rows.set(frame.turnId, row);
    }
    if (frame.event.kind === "user") {
      row.question = frame.event.text;
      row.about = frame.event.about;
    } else if (frame.event.kind === "text") row.reply += frame.event.text;
    else if (frame.event.kind === "read") row.reads.push(frame.event);
  }
  return [...rows.values()];
}
export function keeperContext(page: ConversationPage | null) {
  const event = page?.frames
    .map((frame) => frame.event)
    .reverse()
    .find((event) => event.kind === "context");
  if (
    !event ||
    event.kind !== "context" ||
    event.basis === "unknown" ||
    event.used === null ||
    event.capacity === null
  )
    return {
      percent: null,
      nearlyFull: false,
      label: "Context unknown",
      detail:
        event?.kind === "context"
          ? event.source
          : "Context occupancy has not been reported.",
    };
  const percent = Math.min(
    100,
    Math.round((event.used / event.capacity) * 100),
  );
  return {
    percent,
    nearlyFull: percent >= 85,
    label: `${event.basis === "estimated" ? "Estimated context" : "Context"} ${percent}%`,
    detail: `${event.used.toLocaleString()} / ${event.capacity.toLocaleString()} · ${event.source} · ${event.asOf}`,
  };
}
