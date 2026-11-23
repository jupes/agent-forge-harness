import { z } from "zod";
import type { ConversationFrame } from "../../types/conversation";
import type { GeminiTaskPrivateFrame } from "../../types/gemini-owned-task";
import type { GeminiTaskRuntimeEvent } from "../../types/gemini-task-runtime";
import { reportedJsonSchema, reportedTextSchema } from "./activity-protocol";

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const name = z.string().min(1).max(200);
const model = name.regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/);
const pid = z.number().int().positive().max(0x7fffffff);
const modelUsage = z
  .object({
    totalTokens: count,
    inputTokens: count,
    outputTokens: count,
    cachedInputTokens: count,
    uncachedInputTokens: count,
  })
  .strict();
const usage = modelUsage
  .extend({
    durationMs: count,
    toolCalls: count,
    models: z
      .record(model, modelUsage)
      .refine((value) => Object.keys(value).length <= 32),
  })
  .strict();
const outcome = z
  .object({
    phase: z.enum(["completed", "failed", "unknown"]),
    reason: z.string().max(500).nullable(),
    sessionId: z.string().uuid().nullable(),
    configuredModel: model.nullable(),
    usage: usage.nullable(),
  })
  .strict();
const nativeEvent = z
  .discriminatedUnion("kind", [
    z
      .object({
        kind: z.literal("process"),
        pid,
        bootstrapPid: pid,
        smith: name.max(80),
        requestedModel: model.nullable(),
      })
      .strict(),
    z
      .object({
        kind: z.literal("identity"),
        provider: z.literal("gemini"),
        route: z.literal("gemini-cli"),
        version: z.literal("0.65.0"),
        sessionId: z.string().uuid(),
        configuredModel: model,
      })
      .strict(),
    z
      .object({
        kind: z.literal("text"),
        text: z.string().max(524_288),
        delta: z.boolean(),
      })
      .strict(),
    z
      .object({
        kind: z.literal("tool"),
        id: name,
        name,
        state: z.enum(["requested", "succeeded", "failed"]),
        input: reportedJsonSchema.optional(),
        output: reportedTextSchema.optional(),
        error: z
          .object({ type: name, message: reportedTextSchema })
          .strict()
          .optional(),
      })
      .strict(),
    z
      .object({
        kind: z.literal("notice"),
        severity: z.enum(["warning", "error"]),
        message: reportedTextSchema,
        reportedType: name.optional(),
      })
      .strict(),
    z.object({ kind: z.literal("usage"), usage }).strict(),
    z
      .object({
        kind: z.literal("outcome"),
        outcome,
        exitCode: z.number().int().nullable(),
        stopped: z.boolean(),
        timedOut: z.boolean(),
        stderr: reportedTextSchema,
      })
      .strict(),
  ])
  .transform((value): GeminiTaskRuntimeEvent => {
    if (value.kind === "tool")
      return {
        kind: value.kind,
        id: value.id,
        name: value.name,
        state: value.state,
        ...(value.input === undefined ? {} : { input: value.input }),
        ...(value.output === undefined ? {} : { output: value.output }),
        ...(value.error === undefined ? {} : { error: value.error }),
      };
    if (value.kind === "notice")
      return {
        kind: value.kind,
        severity: value.severity,
        message: value.message,
        ...(value.reportedType === undefined
          ? {}
          : { reportedType: value.reportedType }),
      };
    return value;
  });

/** Native Gemini facts retain their own units and delta semantics in owned private storage. */
export const geminiTaskPrivateFrameSchema = z
  .object({
    kind: z.literal("coding-gemini-task"),
    provider: z.literal("gemini"),
    version: z.literal("0.65.0"),
    event: nativeEvent,
  })
  .strict() satisfies z.ZodType<GeminiTaskPrivateFrame>;

/** Full history proves each native frame against its original launch and actual native process. */
export function validGeminiTaskHistory(value: {
  projectId: string;
  binding: { provider: string; sessionId: string; version: string } | null;
  frames: ConversationFrame[];
}): boolean {
  const turns = new Map<
    string,
    { pid?: number; identity?: string; tools: Map<string, string> }
  >();
  for (const frame of value.frames) {
    if (frame.event.kind !== "coding-gemini-task") continue;
    const user = value.frames.find(
      (candidate) =>
        candidate.turnId === frame.turnId && candidate.event.kind === "user",
    )?.event;
    const snapshot = user?.kind === "user" ? user.geminiTask : undefined;
    if (
      !snapshot ||
      snapshot.launch.context?.projectId !== value.projectId ||
      snapshot.capabilities.version !== frame.event.version
    )
      return false;
    const native = frame.event.event;
    let turn = turns.get(frame.turnId);
    if (!turn) {
      turn = { tools: new Map() };
      turns.set(frame.turnId, turn);
    }
    if (native.kind === "process") {
      if (
        turn.pid !== undefined ||
        native.pid === native.bootstrapPid ||
        native.smith !== snapshot.smith ||
        native.requestedModel !== (snapshot.launch.model ?? null)
      )
        return false;
      turn.pid = native.pid;
    } else if (native.kind === "identity") {
      if (
        !turn.pid ||
        turn.identity ||
        value.binding?.provider !== "gemini" ||
        value.binding.version !== frame.event.version ||
        value.binding.sessionId !== native.sessionId
      )
        return false;
      turn.identity = native.sessionId;
    } else if (native.kind === "outcome") {
      if (
        native.outcome.sessionId !== (turn.identity ?? null) ||
        (native.outcome.phase === "completed" && !turn.identity)
      )
        return false;
    } else if (native.kind === "notice") {
      // Native launch/authentication errors may precede the identity packet.
      if (!turn.pid) return false;
    } else {
      if (!turn.identity) return false;
      if (native.kind === "tool") {
        if (native.state === "requested") {
          if (turn.tools.has(native.id)) return false;
          turn.tools.set(native.id, native.name);
        } else if (turn.tools.get(native.id) !== native.name) return false;
      }
    }
  }
  return true;
}
