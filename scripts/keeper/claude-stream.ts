import { createHash } from "node:crypto";
import type { ConversationEvent } from "../../types/conversation";
import type { KeeperReadQuery } from "../../types/keeper";
import type { ChildExit } from "../executors/types";
import { safeMessage } from "../hearth/api";
import { KEEPER_RESULT_SCHEMA, parseKeeperReadQuery } from "./protocol";

export const KEEPER_CLAUDE_TOOL = "mcp__keeper__read_project";
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const isClaudeSessionId = (value: unknown): value is string =>
  typeof value === "string" && UUID.test(value);
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const protocolError = () =>
  new Error(
    "The Claude stream did not match the restricted conversation protocol.",
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

/** Ordered CLI stream parser. Assistant packets complete blocks, not whole messages. */
export function createClaudeConversationParser(options: {
  projectId: string;
  version: string;
  resumeId?: string;
  now?: () => Date;
}) {
  if (options.resumeId !== undefined && !isClaudeSessionId(options.resumeId))
    throw new Error(
      "The saved Claude resume identity is not a verified session id.",
    );
  const now = options.now ?? (() => new Date());
  const messages = new Map<string, Message>();
  const reads = new Map<string, KeeperReadQuery>();
  const finishedReads = new Map<string, string>();
  const endTools = new Set<string>();
  const assistantPackets = new Map<string, string>();
  let currentMessage: string | null = null;
  let identity: string | null = null;
  let observedModel: string | null = null;
  let terminal: { error: boolean; reason: string | null } | null = null;
  let profileEstablished = false;
  let visibleChars = 0;
  const textEvents = (messageId: string, text: string): ConversationEvent[] => {
    visibleChars += text.length;
    if (visibleChars > 512_000)
      throw new Error("The visible reply exceeded the conversation limit.");
    const result: ConversationEvent[] = [];
    for (let start = 0; start < text.length; ) {
      let end = Math.min(text.length, start + 16_000);
      const last = text.charCodeAt(end - 1);
      if (end < text.length && last >= 0xd800 && last <= 0xdbff) end--;
      result.push({ kind: "text", messageId, text: text.slice(start, end) });
      start = end;
    }
    return result;
  };
  const messageFor = (id: string) => {
    const found = messages.get(id);
    if (!found) throw protocolError();
    return found;
  };
  const modelEvent = (value: unknown): ConversationEvent[] => {
    if (
      typeof value !== "string" ||
      !value.trim() ||
      value.startsWith("<") ||
      value.length > 200 ||
      value === observedModel
    )
      return [];
    observedModel = value;
    return [{ kind: "model", model: value }];
  };
  return {
    line(line: string): ConversationEvent[] {
      if (!line.trim()) return [];
      if (line.length > 1_048_576)
        throw new Error("The provider packet exceeded the conversation limit.");
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        throw protocolError();
      }
      if (!record(value)) throw protocolError();
      if (value["type"] === "assistant" && value["uuid"] !== undefined) {
        const packetId = value["uuid"];
        if (typeof packetId !== "string" || !packetId || packetId.length > 200)
          throw protocolError();
        const digest = createHash("sha256")
          .update(JSON.stringify(value))
          .digest("hex");
        const previous = assistantPackets.get(packetId);
        if (previous !== undefined) {
          if (previous !== digest) throw protocolError();
          return [];
        }
        if (assistantPackets.size >= 2048) throw protocolError();
        assistantPackets.set(packetId, digest);
      }
      if (terminal !== null) throw protocolError();
      const output: ConversationEvent[] = [];
      if (
        value["parent_tool_use_id"] !== undefined &&
        value["parent_tool_use_id"] !== null
      )
        throw protocolError();
      if (value["session_id"] !== undefined) {
        const id = value["session_id"];
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
          output.push({
            kind: "identity",
            provider: "claude",
            sessionId: id,
            version: options.version,
          });
        }
      }
      if (value["type"] === "system" && value["subtype"] === "init") {
        const tools = value["tools"];
        if (
          !Array.isArray(tools) ||
          tools.some(
            (tool) => tool !== KEEPER_CLAUDE_TOOL && tool !== "EndConversation",
          )
        )
          throw new Error(
            "The provider did not establish the Keeper read profile.",
          );
        profileEstablished = tools.includes(KEEPER_CLAUDE_TOOL);
        output.push({
          kind: "context",
          used: null,
          capacity: null,
          basis: "unknown",
          source: "The CLI has not reported context occupancy.",
          asOf: now().toISOString(),
        });
      }
      if (value["type"] === "stream_event") {
        if (!profileEstablished) throw protocolError();
        const event = value["event"];
        if (!record(event)) throw protocolError();
        if (event["type"] === "message_start") {
          const message = event["message"];
          if (
            !record(message) ||
            typeof message["id"] !== "string" ||
            !message["id"] ||
            message["id"].length > 200
          )
            throw protocolError();
          currentMessage = message["id"];
          if (!messages.has(currentMessage))
            messages.set(currentMessage, { active: null, blocks: new Map() });
          if (messages.size > 256)
            throw new Error("The provider exceeded the message limit.");
          output.push(...modelEvent(message["model"]));
        } else if (event["type"] === "content_block_start") {
          const index = event["index"];
          const block = event["content_block"];
          if (
            !currentMessage ||
            !Number.isInteger(index) ||
            typeof index !== "number" ||
            index < 0 ||
            index > 255 ||
            !record(block) ||
            typeof block["type"] !== "string"
          )
            throw protocolError();
          const message = messageFor(currentMessage);
          if (
            block["type"].includes("tool") &&
            (block["type"] !== "tool_use" ||
              (block["name"] !== KEEPER_CLAUDE_TOOL &&
                block["name"] !== "EndConversation"))
          )
            throw new Error(
              "The provider attempted a tool outside the Keeper read profile.",
            );
          if (message.blocks.has(index)) throw protocolError();
          message.active = index;
          const initial =
            block["type"] === "text" && typeof block["text"] === "string"
              ? block["text"]
              : "";
          message.blocks.set(index, {
            type: block["type"],
            text: initial,
            complete: false,
          });
          output.push(...textEvents(currentMessage, initial));
        } else if (event["type"] === "content_block_delta") {
          const delta = event["delta"];
          if (record(delta) && delta["type"] === "text_delta") {
            if (
              !currentMessage ||
              typeof event["index"] !== "number" ||
              typeof delta["text"] !== "string"
            )
              throw protocolError();
            const block = messageFor(currentMessage).blocks.get(event["index"]);
            if (!block || block.type !== "text" || block.complete)
              throw protocolError();
            block.text += delta["text"];
            output.push(...textEvents(currentMessage, delta["text"]));
          }
        } else if (event["type"] === "content_block_stop" && currentMessage) {
          const message = messageFor(currentMessage);
          if (message.active === event["index"]) message.active = null;
        }
      }
      if (value["type"] === "assistant") {
        const message = value["message"];
        if (record(message) && message["model"] === "<synthetic>")
          return output;
        if (!profileEstablished) throw protocolError();
        if (
          !record(message) ||
          typeof message["id"] !== "string" ||
          !Array.isArray(message["content"])
        )
          throw protocolError();
        const id = message["id"];
        const state = messageFor(id);
        output.push(...modelEvent(message["model"]));
        for (const [position, content] of message["content"].entries()) {
          if (!record(content)) throw protocolError();
          if (content["type"] === "tool_use") {
            const toolId = content["id"];
            if (
              typeof toolId !== "string" ||
              !toolId ||
              toolId.length > 200 ||
              reads.size + endTools.size >= 256
            )
              throw protocolError();
            if (content["name"] === "EndConversation") endTools.add(toolId);
            else {
              if (content["name"] !== KEEPER_CLAUDE_TOOL)
                throw new Error(
                  "The provider attempted a tool outside the Keeper read profile.",
                );
              const query = parseKeeperReadQuery(content["input"]);
              const previous = reads.get(toolId);
              if (
                previous &&
                JSON.stringify(previous) !== JSON.stringify(query)
              )
                throw protocolError();
              reads.set(toolId, query);
            }
          }
          if (content["type"] !== "text") continue;
          if (typeof content["text"] !== "string") throw protocolError();
          const index =
            message["content"].length === 1 ? state.active : position;
          const block = index === null ? undefined : state.blocks.get(index);
          if (
            !block ||
            block.type !== "text" ||
            !content["text"].startsWith(block.text)
          )
            throw protocolError();
          output.push(
            ...textEvents(id, content["text"].slice(block.text.length)),
          );
          block.text = content["text"];
          block.complete = true;
        }
      }
      if (
        value["type"] === "user" &&
        record(value["message"]) &&
        Array.isArray(value["message"]["content"])
      ) {
        for (const content of value["message"]["content"]) {
          if (!record(content) || content["type"] !== "tool_result") continue;
          const toolId = content["tool_use_id"];
          if (typeof toolId !== "string") throw protocolError();
          if (endTools.has(toolId)) continue;
          const query = reads.get(toolId);
          if (!query) throw protocolError();
          const digest = createHash("sha256")
            .update(JSON.stringify(content))
            .digest("hex");
          const previous = finishedReads.get(toolId);
          if (previous) {
            if (previous !== digest) throw protocolError();
            continue;
          }
          finishedReads.set(toolId, digest);
          const text =
            typeof content["content"] === "string"
              ? content["content"]
              : Array.isArray(content["content"])
                ? content["content"]
                    .flatMap((item) =>
                      record(item) &&
                      item["type"] === "text" &&
                      typeof item["text"] === "string"
                        ? [item["text"]]
                        : [],
                    )
                    .join("")
                : "";
          let body: unknown;
          try {
            body = JSON.parse(text);
          } catch {
            body = null;
          }
          const result =
            record(body) && body["ok"] === true && body["error"] === null
              ? KEEPER_RESULT_SCHEMA.safeParse(body["data"])
              : null;
          if (
            content["is_error"] !== true &&
            result?.success &&
            result.data.scope.projectId === options.projectId &&
            result.data.kind === query.kind &&
            result.data.mode === (query.id ? "detail" : "index") &&
            (query.id === undefined ||
              result.data.records.every((item) => item.id === query.id))
          ) {
            output.push({
              kind: "read",
              query: query.kind,
              source: result.data.source,
              asOf: result.data.asOf,
              complete: result.data.complete,
              reason: result.data.reason,
              ids: result.data.records.map((item) => item.id),
              nextCursor: result.data.nextCursor,
            });
          } else
            output.push({
              kind: "read",
              query: query.kind,
              source: "Project reader",
              asOf: now().toISOString(),
              complete: false,
              reason:
                "The project read was unavailable or malformed. The answer may be incomplete.",
              ids: [],
              nextCursor: null,
            });
        }
      }
      if (value["type"] === "result") {
        if (terminal !== null) throw protocolError();
        if (value["is_error"] === true)
          terminal = {
            error: true,
            reason:
              typeof value["result"] === "string"
                ? safeMessage(new Error(value["result"]))
                : "The provider reported an unsuccessful turn.",
          };
        else if (value["is_error"] === false && value["subtype"] === "success")
          terminal = { error: false, reason: null };
        else throw protocolError();
      }
      return output;
    },
    finish(exit: Pick<ChildExit, "exitCode" | "timedOut" | "stopped">): {
      phase: "completed" | "failed" | "unknown";
      reason: string | null;
    } {
      if (exit.stopped)
        return {
          phase: "failed",
          reason: "The supervised provider was stopped.",
        };
      if (exit.timedOut)
        return {
          phase: "unknown",
          reason:
            "The provider reached the time limit before confirmed completion.",
        };
      if (identity === null || terminal === null)
        return {
          phase: "unknown",
          reason:
            "The provider did not confirm its identity and terminal result. This turn was not resent.",
        };
      if (terminal.error) return { phase: "failed", reason: terminal.reason };
      if (!profileEstablished)
        return {
          phase: "unknown",
          reason: "The provider did not confirm the restricted read profile.",
        };
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
