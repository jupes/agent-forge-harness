import { createHash } from "node:crypto";
import type { ConversationEvent } from "../../types/conversation";
import type { ChildExit } from "../executors/types";
import { safeMessage } from "../hearth/api";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const isClaudeSessionId = (value: unknown): value is string =>
  typeof value === "string" && UUID.test(value);
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const bad = () =>
  new Error(
    "The Claude coding stream did not match the conversation protocol.",
  );
interface Block {
  type: string;
  text: string;
  complete: boolean;
}
interface Message {
  active: number | null;
  blocks: Map<number, Block>;
}

/** Private coding transcript parser. It grants no tool or operator authority. */
export function createClaudeSessionParser(options: {
  version: string;
  resumeId?: string;
}) {
  if (options.resumeId !== undefined && !isClaudeSessionId(options.resumeId))
    throw bad();
  const messages = new Map<string, Message>();
  const packets = new Map<string, string>();
  let current: string | null = null;
  let identity: string | null = null;
  let observed: string | null = null;
  let terminal: { error: boolean; reason: string | null } | null = null;
  let count = 0;
  let visible = 0;
  const messageFor = (id: unknown): Message => {
    if (typeof id !== "string" || !id || id.length > 200) throw bad();
    let message = messages.get(id);
    if (!message) {
      if (messages.size >= 256) throw bad();
      message = { active: null, blocks: new Map() };
      messages.set(id, message);
    }
    return message;
  };
  const text = (id: string, value: string): ConversationEvent[] => {
    visible += value.length;
    if (visible > 512_000) throw bad();
    const events: ConversationEvent[] = [];
    for (let start = 0; start < value.length; ) {
      let end = Math.min(start + 16_000, value.length);
      const code = value.charCodeAt(end - 1);
      if (end < value.length && code >= 0xd800 && code <= 0xdbff) end--;
      events.push({
        kind: "text",
        messageId: id,
        text: value.slice(start, end),
      });
      start = end;
    }
    return events;
  };
  const model = (value: unknown): ConversationEvent[] => {
    if (
      typeof value !== "string" ||
      !value.trim() ||
      value.length > 200 ||
      value.startsWith("<") ||
      value === observed
    )
      return [];
    observed = value;
    return [{ kind: "model", model: value }];
  };
  return {
    line(line: string): ConversationEvent[] {
      if (!line.trim()) return [];
      if (++count > 4096 || Buffer.byteLength(line) > 1_048_576) throw bad();
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        throw bad();
      }
      if (!record(value) || typeof value.type !== "string") throw bad();
      // Child agents have their own identities and prose; they are not the main reply.
      if (
        value.parent_tool_use_id !== undefined &&
        value.parent_tool_use_id !== null
      ) {
        if (
          typeof value.parent_tool_use_id !== "string" ||
          !value.parent_tool_use_id ||
          value.parent_tool_use_id.length > 200
        )
          throw bad();
        return [];
      }
      if (terminal) throw bad();
      const events: ConversationEvent[] = [];
      if (value.session_id !== undefined) {
        const id = value.session_id;
        if (
          !isClaudeSessionId(id) ||
          (identity !== null && identity !== id) ||
          (options.resumeId !== undefined && options.resumeId !== id)
        )
          throw new Error(
            "The provider did not resume the saved conversation identity.",
          );
        if (identity === null) {
          identity = id;
          events.push({
            kind: "identity",
            provider: "claude",
            sessionId: id,
            version: options.version,
          });
        }
      }
      if (value.type === "stream_event") {
        const event = value.event;
        if (!record(event) || typeof event.type !== "string") throw bad();
        if (event.type === "message_start") {
          if (!record(event.message)) throw bad();
          const id = event.message.id;
          messageFor(id);
          if (typeof id !== "string") throw bad();
          current = id;
          events.push(...model(event.message.model));
        } else if (event.type === "content_block_start") {
          if (
            current === null ||
            typeof event.index !== "number" ||
            !Number.isInteger(event.index) ||
            event.index < 0 ||
            event.index > 255 ||
            !record(event.content_block) ||
            typeof event.content_block.type !== "string"
          )
            throw bad();
          const state = messageFor(current);
          if (state.blocks.has(event.index)) throw bad();
          const initial =
            event.content_block.type === "text" ? event.content_block.text : "";
          if (typeof initial !== "string") throw bad();
          state.active = event.index;
          state.blocks.set(event.index, {
            type: event.content_block.type,
            text: initial,
            complete: false,
          });
          events.push(...text(current, initial));
        } else if (event.type === "content_block_delta") {
          if (!record(event.delta)) throw bad();
          if (event.delta.type === "text_delta") {
            if (
              current === null ||
              typeof event.index !== "number" ||
              typeof event.delta.text !== "string"
            )
              throw bad();
            const block = messageFor(current).blocks.get(event.index);
            if (!block || block.type !== "text" || block.complete) throw bad();
            block.text += event.delta.text;
            events.push(...text(current, event.delta.text));
          }
        }
      } else if (value.type === "assistant") {
        const message = value.message;
        if (!record(message)) throw bad();
        if (message.model === "<synthetic>") return events;
        if (
          typeof message.id !== "string" ||
          !Array.isArray(message.content) ||
          message.content.length > 256
        )
          throw bad();
        if (value.uuid !== undefined) {
          if (
            typeof value.uuid !== "string" ||
            !value.uuid ||
            value.uuid.length > 200
          )
            throw bad();
          const digest = createHash("sha256")
            .update(JSON.stringify(value))
            .digest("hex");
          const previous = packets.get(value.uuid);
          if (previous !== undefined) {
            if (previous !== digest) throw bad();
            return events;
          }
          if (packets.size >= 2048) throw bad();
          packets.set(value.uuid, digest);
        }
        const state = messageFor(message.id);
        events.push(...model(message.model));
        for (const [position, item] of message.content.entries()) {
          if (!record(item) || typeof item.type !== "string") throw bad();
          if (item.type !== "text") continue; // No tool inputs, outputs or thinking bodies are projected.
          if (typeof item.text !== "string") throw bad();
          const index =
            message.content.length === 1
              ? (state.active ?? position)
              : position;
          const previous = state.blocks.get(index);
          if (
            previous &&
            (previous.type !== "text" ||
              !item.text.startsWith(previous.text) ||
              (previous.complete && previous.text !== item.text))
          )
            throw bad();
          events.push(
            ...text(message.id, item.text.slice(previous?.text.length ?? 0)),
          );
          state.blocks.set(index, {
            type: "text",
            text: item.text,
            complete: true,
          });
        }
      } else if (value.type === "result") {
        if (value.is_error === true)
          terminal = {
            error: true,
            reason:
              typeof value.result === "string"
                ? safeMessage(new Error(value.result))
                : "The provider reported an unsuccessful turn.",
          };
        else if (value.is_error === false && value.subtype === "success")
          terminal = { error: false, reason: null };
        else throw bad();
      }
      return events;
    },
    finish(exit: Pick<ChildExit, "exitCode" | "timedOut" | "stopped">): {
      phase: "completed" | "failed" | "unknown";
      reason: string | null;
    } {
      if (exit.timedOut)
        return {
          phase: "unknown",
          reason:
            "The provider timed out before confirmed completion. This turn was not resent.",
        };
      if (exit.stopped)
        return {
          phase: "failed",
          reason: "The supervised provider was stopped.",
        };
      if (identity === null || terminal === null)
        return {
          phase: "unknown",
          reason:
            "The provider did not confirm its identity and terminal result. This turn was not resent.",
        };
      if (terminal.error) return { phase: "failed", reason: terminal.reason };
      return exit.exitCode === 0
        ? { phase: "completed", reason: null }
        : {
            phase: "unknown",
            reason:
              "The provider exited unsuccessfully after its result. Completion is unknown.",
          };
    },
  };
}
