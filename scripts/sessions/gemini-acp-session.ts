import { z } from "zod";
import type { GeminiAcpEvent } from "../../types/gemini-acp";
import {
  type AcpRpcId,
  decodeAcpServerFrame,
  encodeAcpClientRequest,
  encodeAcpPermissionReply,
} from "./acp-wire";
import { reportedJson, reportedText } from "./activity-protocol";

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
const nativeId = z
  .string()
  .min(1)
  .max(200)
  .refine((value) => !/[\p{Cc}\p{Cs}]/u.test(value));
const toolStatus = z.enum(["pending", "in_progress", "completed", "failed"]);
const tool = z
  .object({
    toolCallId: nativeId,
    title: text.nullable().optional(),
    status: toolStatus.nullable().optional(),
    kind: z
      .enum([
        "read",
        "edit",
        "delete",
        "move",
        "search",
        "execute",
        "think",
        "fetch",
        "switch_mode",
        "other",
      ])
      .nullable()
      .optional(),
    content: z.array(z.unknown()).max(128).nullable().optional(),
    locations: z.array(z.unknown()).max(128).nullable().optional(),
    rawInput: z.unknown().optional(),
    rawOutput: z.unknown().optional(),
  })
  .passthrough();
const nativePermission = z
  .object({
    sessionId: uuid,
    toolCall: tool,
    options: z
      .array(
        z
          .object({
            optionId: nativeId,
            name: text,
            kind: z.enum([
              "allow_once",
              "reject_once",
              "allow_always",
              "reject_always",
            ]),
          })
          .strip(),
      )
      .min(1)
      .max(16),
  })
  .passthrough();
type State =
  | "cold"
  | "initialize"
  | "open"
  | "ready"
  | "prompt"
  | "cancelling"
  | "dead";

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
  const permissions = new Map<
    AcpRpcId,
    {
      requestId: string;
      toolCallId: string;
      options: Extract<GeminiAcpEvent, { kind: "permission" }>["options"];
    }
  >();
  const seenPermissionIds = new Set<AcpRpcId>();
  const tools = new Map<string, z.infer<typeof toolStatus>>();
  const thoughtTools = new Set<string>();
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
      // A terminal acknowledgement closes the previous prompt's tool obligations.
      // Lifetime permission identities and thought-tool redaction remain fenced.
      tools.clear();
      outputBytes = 0;
      return frame;
    },
    /** Trusted owner must first persist the exact original decision intent; this consumes the offer once. */
    answerPermission(input: {
      rpcId: AcpRpcId;
      requestId: string;
      optionId: string | null;
    }): string {
      const offered = permissions.get(input.rpcId);
      if (
        state !== "prompt" ||
        !requestId ||
        offered?.requestId !== requestId ||
        input.requestId !== requestId ||
        (input.optionId !== null &&
          !offered.options.some((option) => option.optionId === input.optionId))
      )
        throw invalid();
      const frame = encodeAcpPermissionReply(
        input.rpcId,
        input.optionId === null
          ? { outcome: "cancelled" }
          : { outcome: "selected", optionId: input.optionId },
      );
      permissions.delete(input.rpcId);
      return frame;
    },
    cancel(originalRequestId: string): string | null {
      if (state === "ready" && originals.has(originalRequestId)) return null;
      if (state !== "prompt" || !sessionId || requestId !== originalRequestId)
        throw invalid();
      // Invalidate callbacks synchronously before the caller yields while writing cancellation.
      state = "cancelling";
      permissions.clear();
      return encodeAcpClientRequest({
        method: "session/cancel",
        params: { sessionId },
      });
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
          if (!sessionId) throw invalid();
          if (frame.method === "session/request_permission") {
            const value = nativePermission.parse(frame.params);
            if (
              value.sessionId !== sessionId ||
              state !== "prompt" ||
              !requestId ||
              seenPermissionIds.has(frame.id) ||
              permissions.size >= 32 ||
              seenPermissionIds.size >= 128 ||
              new Set(value.options.map((option) => option.optionId)).size !==
                value.options.length ||
              [...permissions.values()].some(
                (offer) => offer.toolCallId === value.toolCall.toolCallId,
              ) ||
              value.toolCall.status === "completed" ||
              value.toolCall.status === "failed" ||
              tools.get(value.toolCall.toolCallId) === "completed" ||
              tools.get(value.toolCall.toolCallId) === "failed"
            )
              throw invalid();
            if (value.toolCall.kind === "think")
              thoughtTools.add(value.toolCall.toolCallId);
            const detail = reportedJson(value.toolCall);
            const detailsComplete =
              !detail.truncated &&
              !thoughtTools.has(value.toolCall.toolCallId) &&
              (typeof value.toolCall.title === "string" ||
                value.toolCall.rawInput !== undefined ||
                (value.toolCall.content?.length ?? 0) > 0);
            const selectable: Extract<
              GeminiAcpEvent,
              { kind: "permission" }
            >["options"] = [];
            for (const option of value.options)
              if (
                option.kind === "reject_once" ||
                (option.kind === "allow_once" && detailsComplete)
              )
                selectable.push({
                  optionId: option.optionId,
                  name: option.name,
                  kind: option.kind,
                });
            if (tools.size >= 128 && !tools.has(value.toolCall.toolCallId))
              throw invalid();
            tools.set(
              value.toolCall.toolCallId,
              value.toolCall.status ?? "pending",
            );
            permissions.set(frame.id, {
              requestId,
              toolCallId: value.toolCall.toolCallId,
              options: selectable,
            });
            seenPermissionIds.add(frame.id);
            events.push({
              kind: "permission",
              rpcId: frame.id,
              requestId,
              toolCallId: value.toolCall.toolCallId,
              detail: thoughtTools.has(value.toolCall.toolCallId)
                ? reportedJson({
                    toolCallId: value.toolCall.toolCallId,
                    detail: "Native thought tool details are not retained.",
                  })
                : detail,
              detailsComplete,
              options: selectable,
            });
            return { send, events };
          }
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
              (!resume &&
                ((state !== "prompt" && state !== "cancelling") ||
                  !requestId)) ||
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
          } else if (tag === "tool_call" || tag === "tool_call_update") {
            const value = tool.parse(notification.parse(frame.params).update);
            if (
              !resume &&
              ((state !== "prompt" && state !== "cancelling") || !requestId)
            )
              throw invalid();
            if (tools.size >= 128 && !tools.has(value.toolCallId))
              throw invalid();
            const status =
              value.status ?? tools.get(value.toolCallId) ?? "pending";
            tools.set(value.toolCallId, status);
            if (value.kind === "think") thoughtTools.add(value.toolCallId);
            if (status === "completed" || status === "failed")
              for (const [rpc, offer] of permissions)
                if (offer.toolCallId === value.toolCallId)
                  permissions.delete(rpc);
            if (!thoughtTools.has(value.toolCallId))
              events.push({
                kind: "tool",
                toolCallId: value.toolCallId,
                status,
                scope: resume ? "native-session" : "turn",
                requestId: resume ? null : requestId,
                detail: reportedJson(value),
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
        if (frame.id !== pending) throw invalid();
        if ("error" in frame) {
          state = "dead";
          permissions.clear();
          events.push({
            kind: "error",
            requestId,
            code: frame.error.code,
            message: reportedText(frame.error.message),
          });
          return { send, events };
        }
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
        } else if (
          (state === "prompt" || state === "cancelling") &&
          requestId
        ) {
          const result = completed.parse(frame.result);
          if (state === "cancelling" && result.stopReason !== "cancelled")
            throw invalid();
          if (
            result.stopReason === "end_turn" &&
            (permissions.size ||
              [...tools.values()].some(
                (status) => status === "pending" || status === "in_progress",
              ))
          )
            throw invalid();
          events.push({
            kind: "result",
            requestId,
            stopReason: result.stopReason,
            usage: result.usage ?? null,
          });
          state = "ready";
          requestId = null;
          permissions.clear();
        } else throw invalid();
        return { send, events };
      } catch {
        state = "dead";
        permissions.clear();
        throw invalid();
      }
    },
    invalidate(): void {
      state = "dead";
      requestId = null;
      permissions.clear();
    },
  };
}
