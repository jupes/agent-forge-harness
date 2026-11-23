import { z } from "zod";
import type {
  GeminiTaskOutcome,
  GeminiTaskPrivateEvent,
  GeminiTaskUsage,
} from "../../types/gemini-task";
import type { ChildExit } from "../executors/types";
import { reportedJson, reportedText } from "./activity-protocol";
import { privatePacketHash } from "./private-packet";

export const GEMINI_TASK_STREAM_LIMITS = {
  lines: 4096,
  lineBytes: 1_048_576,
  totalBytes: 8_388_608,
  textBytes: 524_288,
  tools: 128,
} as const;

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const encoder = new TextEncoder();
const wellFormed = (value: string) =>
  !value.includes("\0") &&
  !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(
    value,
  );
const id = z
  .string()
  .min(1)
  .max(200)
  .refine(
    (value) =>
      wellFormed(value) &&
      [...value].every(
        (character) =>
          character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127,
      ),
  );
const model = z
  .string()
  .max(200)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/);
const nativeModelUsage = z.object({
  total_tokens: count,
  input_tokens: count,
  output_tokens: count,
  cached: count,
  input: count,
});
const nativeUsage = nativeModelUsage.extend({
  duration_ms: count,
  tool_calls: count,
  models: z
    .record(model, nativeModelUsage)
    .refine((value) => Object.keys(value).length <= 32),
});
const base = z.object({ timestamp: z.iso.datetime({ offset: true }) });
const nativeError = z.object({ type: id, message: z.string() });
const packet = z.discriminatedUnion("type", [
  base
    .extend({ type: z.literal("init"), session_id: z.uuid(), model })
    .passthrough(),
  base
    .extend({
      type: z.literal("message"),
      role: z.enum(["user", "assistant"]),
      content: z
        .string()
        .max(GEMINI_TASK_STREAM_LIMITS.textBytes)
        .refine(wellFormed),
      delta: z.boolean().optional(),
    })
    .passthrough(),
  base
    .extend({
      type: z.literal("tool_use"),
      tool_id: id,
      tool_name: id,
      parameters: z.record(z.string(), z.unknown()),
    })
    .passthrough(),
  base
    .extend({
      type: z.literal("tool_result"),
      tool_id: id,
      status: z.enum(["success", "error"]),
      output: z.string().optional(),
      error: nativeError.optional(),
    })
    .passthrough(),
  base
    .extend({
      type: z.literal("error"),
      severity: z.enum(["warning", "error"]),
      message: z.string(),
    })
    .passthrough(),
  base
    .extend({
      type: z.literal("result"),
      status: z.enum(["success", "error"]),
      stats: nativeUsage.optional(),
      error: nativeError.optional(),
    })
    .passthrough(),
]);
const invalid = () =>
  new Error("The Gemini stream did not match the private Task protocol.");
const modelUsage = (value: z.infer<typeof nativeModelUsage>) => ({
  totalTokens: value.total_tokens,
  inputTokens: value.input_tokens,
  outputTokens: value.output_tokens,
  cachedInputTokens: value.cached,
  uncachedInputTokens: value.input,
});

export function createGeminiTaskParser(options: { version: string }) {
  if (options.version !== "0.65.0") throw invalid();
  let sessionId: string | null = null,
    configuredModel: string | null = null;
  let terminal: "success" | "error" | null = null;
  let usage: GeminiTaskUsage | null = null;
  let broken = false,
    finished = false,
    providerError = false;
  let lines = 0,
    bytes = 0,
    textBytes = 0;
  const tools = new Map<
    string,
    { name: string; inputHash: string; resultHash: string | null }
  >();
  const read = (line: string): GeminiTaskPrivateEvent[] => {
    if (finished || broken) throw invalid();
    const size = encoder.encode(line).byteLength;
    bytes += size;
    if (
      ++lines > GEMINI_TASK_STREAM_LIMITS.lines ||
      size > GEMINI_TASK_STREAM_LIMITS.lineBytes ||
      bytes > GEMINI_TASK_STREAM_LIMITS.totalBytes
    )
      throw invalid();
    if (!line.trim()) return [];
    if (terminal !== null) throw invalid();
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      throw invalid();
    }
    const parsed = packet.safeParse(raw);
    if (!parsed.success) throw invalid();
    const value = parsed.data;
    if (value.type !== "init" && "session_id" in value) {
      const reported = z.uuid().safeParse(value.session_id);
      if (!reported.success || reported.data.toLowerCase() !== sessionId)
        throw invalid();
    }
    if (value.type === "init") {
      if (sessionId !== null) throw invalid();
      sessionId = value.session_id.toLowerCase();
      configuredModel = value.model;
      return [
        {
          kind: "identity",
          provider: "gemini",
          route: "gemini-cli",
          version: options.version,
          sessionId,
          configuredModel,
        },
      ];
    }
    if (value.type === "result") {
      if (sessionId === null && value.status === "success") throw invalid();
      if (value.error && value.status === "success") throw invalid();
      terminal = value.status;
      const events: GeminiTaskPrivateEvent[] = value.error
        ? [
            {
              kind: "notice",
              severity: "error",
              reportedType: value.error.type,
              message: reportedText(value.error.message),
            },
          ]
        : [];
      if (!value.stats) return events;
      usage = {
        ...modelUsage(value.stats),
        durationMs: value.stats.duration_ms,
        toolCalls: value.stats.tool_calls,
        models: Object.fromEntries(
          Object.entries(value.stats.models).map(([name, counts]) => [
            name,
            modelUsage(counts),
          ]),
        ),
      };
      events.push({ kind: "usage", usage: structuredClone(usage) });
      return events;
    }
    if (value.type === "error") {
      if (value.severity === "error") providerError = true;
      return [
        {
          kind: "notice",
          severity: value.severity,
          message: reportedText(value.message),
        },
      ];
    }
    if (sessionId === null) throw invalid();
    if (value.type === "tool_use") {
      const input = reportedJson(value.parameters);
      const inputHash = privatePacketHash({
        name: value.tool_name,
        parameters: value.parameters,
      });
      const existing = tools.get(value.tool_id);
      if (existing) {
        if (existing.inputHash !== inputHash) throw invalid();
        return [];
      }
      if (tools.size >= GEMINI_TASK_STREAM_LIMITS.tools) throw invalid();
      tools.set(value.tool_id, {
        name: value.tool_name,
        inputHash,
        resultHash: null,
      });
      return [
        {
          kind: "tool",
          id: value.tool_id,
          name: value.tool_name,
          state: "requested",
          input,
        },
      ];
    }
    if (value.type === "tool_result") {
      const tool = tools.get(value.tool_id);
      if (!tool || (value.status === "success" && value.error)) throw invalid();
      const resultHash = privatePacketHash({
        status: value.status,
        output: value.output,
        error: value.error,
      });
      if (tool.resultHash !== null) {
        if (tool.resultHash !== resultHash) throw invalid();
        return [];
      }
      tool.resultHash = resultHash;
      return [
        {
          kind: "tool",
          id: value.tool_id,
          name: tool.name,
          state: value.status === "success" ? "succeeded" : "failed",
          ...(value.output === undefined
            ? {}
            : { output: reportedText(value.output) }),
          ...(value.error === undefined
            ? {}
            : {
                error: {
                  type: value.error.type,
                  message: reportedText(value.error.message),
                },
              }),
        },
      ];
    }
    if (value.role === "user") return [];
    textBytes += encoder.encode(value.content).byteLength;
    if (textBytes > GEMINI_TASK_STREAM_LIMITS.textBytes) throw invalid();
    return [{ kind: "text", text: value.content, delta: value.delta ?? false }];
  };
  return {
    read(line: string): GeminiTaskPrivateEvent[] {
      try {
        return read(line);
      } catch {
        broken = true;
        throw invalid();
      }
    },
    finish(exit: ChildExit): GeminiTaskOutcome {
      if (finished) throw invalid();
      finished = true;
      const failed =
        exit.exitCode !== 0 ||
        exit.timedOut ||
        exit.stopped ||
        terminal === "error" ||
        providerError;
      const complete =
        !broken &&
        terminal === "success" &&
        sessionId !== null &&
        [...tools.values()].every((tool) => tool.resultHash !== null);
      return {
        phase: failed ? "failed" : complete ? "completed" : "unknown",
        reason: failed
          ? "The Gemini Task did not complete successfully."
          : complete
            ? null
            : "The Gemini Task completion could not be verified.",
        sessionId,
        configuredModel,
        usage: usage ? structuredClone(usage) : null,
      };
    },
  };
}
