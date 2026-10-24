import { COMMANDS } from "../../../docs/js/generated/commands";
import { KEEPER_OBJECT_READS } from "../../../scripts/keeper/objects";
import { KEEPER_RESULT_SCHEMA } from "../../../scripts/keeper/protocol";
import type { ConversationObject } from "../../../types/conversation";

export type KeeperPicker =
  | {
      mode: "mention";
      kind: ConversationObject["kind"];
      query: string;
      start: number;
      end: number;
    }
  | { mode: "command"; query: string; start: number; end: number };

export function keeperPicker(text: string, caret: number): KeeperPicker | null {
  const before = text.slice(0, caret);
  const match = /(?:^|\s)(@[^\s@]*|\/[a-z0-9-]*)$/i.exec(before);
  const token = match?.[1];
  if (!token) return null;
  const start = caret - token.length;
  if (token.startsWith("/"))
    return { mode: "command", query: token, start, end: caret };
  const mention = /^@(?:(bead|session|run|event):)?([^:]{0,200})$/.exec(token);
  if (!mention) return null;
  const kind = mention[1] ?? "bead";
  if (
    kind !== "bead" &&
    kind !== "session" &&
    kind !== "run" &&
    kind !== "event"
  )
    return null;
  return { mode: "mention", kind, query: mention[2] ?? "", start, end: caret };
}

export function insertKeeperSuggestion(
  text: string,
  picker: KeeperPicker,
  value: string,
) {
  const tail = text.slice(picker.end);
  return {
    text:
      text.slice(0, picker.start) +
      value +
      (tail.startsWith(" ") ? "" : " ") +
      tail,
    caret: picker.start + value.length + 1,
  };
}

export const keeperCommands = (query: string) =>
  COMMANDS.filter((item) =>
    item.name.toLowerCase().startsWith(query.toLowerCase()),
  );

export function keeperObjects(
  projectId: string,
  kind: ConversationObject["kind"],
  raw: unknown,
  id?: string,
) {
  const parsed = KEEPER_RESULT_SCHEMA.safeParse(raw);
  if (
    !parsed.success ||
    parsed.data.scope.projectId !== projectId ||
    parsed.data.kind !== KEEPER_OBJECT_READS[kind] ||
    parsed.data.mode !== (id === undefined ? "index" : "detail") ||
    (id !== undefined &&
      (parsed.data.records.length !== 1 ||
        parsed.data.records[0]?.id !== id)) ||
    new Set(parsed.data.records.map((row) => row.id)).size !==
      parsed.data.records.length
  )
    throw new Error("The object read could not be verified in this project.");
  const result = parsed.data;
  return {
    items: result.records.map((row) => {
      const data = row.data;
      const title =
        data !== null &&
        typeof data === "object" &&
        "title" in data &&
        typeof data.title === "string"
          ? data.title.slice(0, 160)
          : row.id;
      return { kind, id: row.id, title };
    }),
    source: result.source,
    asOf: result.asOf,
    complete: result.complete,
    reason: result.reason,
    more: result.nextCursor !== null,
  };
}

export interface KeeperAbout extends ConversationObject {
  status: "loading" | "ready" | "error";
  title: string;
  source: string | null;
  asOf: string | null;
  complete: boolean;
  reason: string | null;
}
