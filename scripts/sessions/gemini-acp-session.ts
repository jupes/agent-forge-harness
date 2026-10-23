import { z } from "zod";
import type { GeminiAcpEvent } from "../../types/gemini-acp";
import { decodeAcpServerFrame, encodeAcpClientRequest } from "./acp-wire";

const invalid = () =>
  new Error(
    "The message or action did not match the private Gemini ACP session.",
  );
const uuid = z.uuid();
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const text = z
  .string()
  .max(524_288)
  .refine(
    (value) =>
      !value.includes("\0") &&
      !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(
        value,
      ),
  );
const content = z.object({ type: z.literal("text"), text }).passthrough();
const initialized = z
  .object({
    protocolVersion: z.literal(1),
    agentInfo: z
      .object({ name: z.literal("gemini-cli"), version: z.literal("0.65.0") })
      .passthrough(),
    agentCapabilities: z
      .object({ loadSession: z.boolean().optional() })
      .passthrough()
      .optional(),
  })
  .passthrough();
const opened = z.object({ sessionId: uuid }).passthrough();
const usage = z
  .object({
    inputTokens: count,
    outputTokens: count,
    totalTokens: count,
    cachedReadTokens: count.optional(),
    thoughtTokens: count.optional(),
  })
  .strip()
  .transform((value) => ({
    inputTokens: value.inputTokens,
    outputTokens: value.outputTokens,
    totalTokens: value.totalTokens,
    ...(value.cachedReadTokens === undefined
      ? {}
      : { cachedReadTokens: value.cachedReadTokens }),
    ...(value.thoughtTokens === undefined
      ? {}
      : { thoughtTokens: value.thoughtTokens }),
  }));
const completed = z
  .object({
    stopReason: z.enum([
      "end_turn",
      "max_tokens",
      "max_turn_requests",
      "refusal",
      "cancelled",
    ]),
    usage: usage.nullable().optional(),
  })
  .passthrough();
const notification = z
  .object({
    sessionId: uuid,
    update: z
      .object({ sessionUpdate: z.string().min(1).max(100) })
      .passthrough(),
  })
  .passthrough();
const chunk = z.object({ content }).passthrough();
const context = z.object({ used: count, size: count }).passthrough();
type State = "cold" | "initialize" | "open" | "ready" | "prompt" | "dead";

/** Pure protocol state; the caller persists ownership and decisions before sending returned frames. */
export function createGeminiAcpSession(options: {
  cwd: string;
  resumeSessionId?: string;
}) {
  const resume =
    options.resumeSessionId === undefined
      ? null
      : uuid.parse(options.resumeSessionId);
  let state: State = "cold",
    id = 0,
    pending = 0;
  let sessionId: string | null = resume,
    requestId: string | null = null;
  let bytes = 0,
    frames = 0,
    outputBytes = 0;
  const originals = new Set<string>();
  const request = (method: string, params: Record<string, unknown>) => {
    pending = ++id;
    return encodeAcpClientRequest({ id: pending, method, params });
  };
  return {
    start(): string {
      if (state !== "cold") throw invalid();
      state = "initialize";
      return request("initialize", {
        protocolVersion: 1,
        clientCapabilities: {},
        clientInfo: { name: "agent-forge-harness", version: "1" },
      });
    },
    prompt(input: { requestId: string; text: string }): string {
      const parsed = z
        .object({
          requestId: uuid,
          text: text.refine((value) => value.trim().length > 0),
        })
        .strict()
        .safeParse(input);
      if (
        state !== "ready" ||
        !sessionId ||
        !parsed.success ||
        originals.has(parsed.data.requestId) ||
        originals.size >= 128
      )
        throw invalid();
      const frame = request("session/prompt", {
        sessionId,
        prompt: [{ type: "text", text: parsed.data.text }],
      });
      requestId = parsed.data.requestId;
      originals.add(requestId);
      state = "prompt";
      outputBytes = 0;
      return frame;
    },
    read(line: string): { send: string[]; events: GeminiAcpEvent[] } {
      try {
        bytes += Buffer.byteLength(line);
        if (
          state === "cold" ||
          state === "dead" ||
          bytes > 8_388_608 ||
          ++frames > 4096
        )
          throw invalid();
        const frame = decodeAcpServerFrame(line);
        const events: GeminiAcpEvent[] = [],
          send: string[] = [];
        if ("method" in frame) {
          if (frame.method !== "session/update" || !sessionId) throw invalid();
          const value = notification.parse(frame.params);
          if (value.sessionId !== sessionId) throw invalid();
          const tag = value.update.sessionUpdate;
          if (
            [
              "agent_message_chunk",
              "user_message_chunk",
              "agent_thought_chunk",
            ].includes(tag)
          ) {
            const parsed = chunk.parse(value.update);
            if (
              (!resume && (state !== "prompt" || !requestId)) ||
              (resume && state === "initialize")
            )
              throw invalid();
            outputBytes += Buffer.byteLength(parsed.content.text);
            if (outputBytes > 524_288) throw invalid();
            if (tag !== "agent_thought_chunk")
              events.push({
                kind: "text",
                text: parsed.content.text,
                role: tag === "agent_message_chunk" ? "assistant" : "user",
                scope: resume ? "native-session" : "turn",
                requestId: resume ? null : requestId,
              });
          } else if (tag === "usage_update") {
            const parsed = context.parse(value.update);
            events.push({
              kind: "context",
              usedTokens: parsed.used,
              contextTokens: parsed.size,
            });
          } else if (
            ![
              "available_commands_update",
              "current_mode_update",
              "config_option_update",
              "session_info_update",
            ].includes(tag)
          )
            throw invalid();
          return { send, events };
        }
        if (frame.id !== pending || "error" in frame) throw invalid();
        if (state === "initialize") {
          const evidence = initialized.parse(frame.result);
          if (resume && evidence.agentCapabilities?.loadSession !== true)
            throw invalid();
          state = "open";
          send.push(
            request(resume ? "session/load" : "session/new", {
              cwd: options.cwd,
              mcpServers: [],
              ...(resume ? { sessionId: resume } : {}),
            }),
          );
        } else if (state === "open") {
          if (resume) {
            z.object({}).passthrough().parse(frame.result);
          } else sessionId = opened.parse(frame.result).sessionId;
          if (!sessionId) throw invalid();
          state = "ready";
          events.push({
            kind: "identity",
            sessionId,
            resumed: resume !== null,
          });
        } else if (state === "prompt" && requestId) {
          const result = completed.parse(frame.result);
          events.push({
            kind: "result",
            requestId,
            stopReason: result.stopReason,
            usage: result.usage ?? null,
          });
          state = "ready";
          requestId = null;
        } else throw invalid();
        return { send, events };
      } catch {
        state = "dead";
        throw invalid();
      }
    },
    invalidate(): void {
      state = "dead";
      requestId = null;
    },
  };
}
