import { z } from "zod";
import type {
  CodexChatApproval,
  CodexChatCommand,
  CodexChatEvent,
  CodexChatOutcome,
} from "../../types/codex-chat";
import type {
  CodexChatDecisionIntent,
  CodexChatPrivateEvent,
} from "../../types/codex-owned-chat";
import type { CodexExecUsage } from "../../types/codex-task";
import {
  reportedTextSchema,
  SESSION_ACTIVITY_LIMITS,
} from "./activity-protocol";
import {
  CODEX_APP_SERVER_VERSION,
  codexNativeUuidSchema,
} from "./codex-app-server-protocol";
import { codexChatDecisionReceiptSchema } from "./codex-chat-owned-protocol";
import { sessionRequestHashSchema, sessionRequestIdSchema } from "./protocol";

const text = z
  .string()
  .max(16_384)
  .refine((value) => !value.includes("\0"));
const name = text.min(1).max(200);
const pid = z.number().int().positive().max(0x7fffffff);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const usage = z
  .object({
    inputTokens: count.optional(),
    outputTokens: count.optional(),
    cachedInputTokens: count.optional(),
    cacheWriteInputTokens: count.optional(),
    reasoningOutputTokens: count.optional(),
  })
  .strict()
  .transform(
    (value): CodexExecUsage => ({
      ...(value.inputTokens === undefined
        ? {}
        : { inputTokens: value.inputTokens }),
      ...(value.outputTokens === undefined
        ? {}
        : { outputTokens: value.outputTokens }),
      ...(value.cachedInputTokens === undefined
        ? {}
        : { cachedInputTokens: value.cachedInputTokens }),
      ...(value.cacheWriteInputTokens === undefined
        ? {}
        : { cacheWriteInputTokens: value.cacheWriteInputTokens }),
      ...(value.reasoningOutputTokens === undefined
        ? {}
        : { reasoningOutputTokens: value.reasoningOutputTokens }),
    }),
  );
const decision = z.enum(["accept", "decline", "cancel"]);
export const codexChatCommandSchema = z
  .object({
    kind: z.literal("command"),
    source: z.enum([
      "item/started",
      "item/commandExecution/outputDelta",
      "item/completed",
      "turn/completed",
    ]),
    threadId: codexNativeUuidSchema,
    turnId: codexNativeUuidSchema,
    itemId: name.max(160),
    command: reportedTextSchema.refine((value) => value.text.length > 0),
    cwd: text.min(1).max(1024),
    status: z.enum(["inProgress", "completed", "failed", "declined"]),
    output: reportedTextSchema.nullable(),
    outputSource: z.enum(["delta", "aggregate"]).nullable(),
    exitCode: z
      .number()
      .int()
      .min(-2_147_483_648)
      .max(2_147_483_647)
      .nullable(),
    durationMs: count.nullable(),
    partial: z.boolean(),
  })
  .strict()
  .refine((value) => {
    const delta = value.source === "item/commandExecution/outputDelta";
    const active = value.source === "item/started" || delta;
    return (
      active === (value.status === "inProgress") &&
      value.partial === active &&
      (delta
        ? value.output !== null &&
          value.outputSource === "delta" &&
          value.exitCode === null &&
          value.durationMs === null
        : value.outputSource ===
          (value.output === null ? null : "aggregate")) &&
      new TextEncoder().encode(JSON.stringify(value)).byteLength <=
        SESSION_ACTIVITY_LIMITS.eventBytes
    );
  }) satisfies z.ZodType<CodexChatCommand>;
export const codexChatOutcomeSchema = z
  .object({
    phase: z.enum(["completed", "failed", "unknown"]),
    reason: text.nullable(),
    threadId: codexNativeUuidSchema.nullable(),
    turnId: codexNativeUuidSchema.nullable(),
    observedModel: z.null(),
    usage: z
      .object({ lastResponse: usage, threadTotal: usage })
      .strict()
      .nullable(),
    exitCode: z.number().int().min(-0x80000000).max(0xffffffff).nullable(),
    stopped: z.boolean(),
    timedOut: z.boolean(),
  })
  .strict()
  .refine(
    (value) =>
      value.phase !== "completed" ||
      (value.exitCode === 0 &&
        value.threadId !== null &&
        value.turnId !== null &&
        !value.stopped &&
        !value.timedOut),
  ) satisfies z.ZodType<CodexChatOutcome>;
export const codexChatApprovalSchema = z
  .object({
    id: sessionRequestIdSchema,
    provider: z.literal("codex"),
    processId: pid,
    nativeRequestId: z.union([name, count]),
    nativeApprovalId: name.nullable(),
    threadId: codexNativeUuidSchema,
    turnId: codexNativeUuidSchema,
    itemId: name,
    kind: z.enum(["command", "file-change"]),
    command: text.nullable(),
    cwd: text.max(1024).nullable(),
    reason: text.nullable(),
    availableDecisions: z
      .array(decision)
      .min(1)
      .max(3)
      .refine((values) => new Set(values).size === values.length),
  })
  .strict()
  .refine(
    (value) => value.kind !== "command" || (!!value.command && !!value.cwd),
  ) satisfies z.ZodType<CodexChatApproval>;
const nativeEvent = z.discriminatedUnion("kind", [
  codexChatCommandSchema,
  z
    .object({
      kind: z.literal("process"),
      pid,
      wrapperPid: pid,
      smith: name.max(80),
      requestedModel: name,
      requestedEffort: name.max(64).nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("identity"),
      provider: z.literal("codex"),
      threadId: codexNativeUuidSchema,
      version: z.literal(CODEX_APP_SERVER_VERSION),
    })
    .strict(),
  z
    .object({
      kind: z.literal("configuration"),
      model: name,
      modelProvider: name,
      effort: name.max(64).nullable(),
      cwd: text.min(1).max(1024),
    })
    .strict(),
  z
    .object({
      kind: z.literal("turn"),
      threadId: codexNativeUuidSchema,
      turnId: codexNativeUuidSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("text"),
      itemId: name,
      text: z.string().max(1_048_576),
    })
    .strict(),
  z
    .object({
      kind: z.literal("usage"),
      usage: z.object({ lastResponse: usage, threadTotal: usage }).strict(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("outcome"),
      outcome: codexChatOutcomeSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("reroute"),
      fromModel: name,
      toModel: name,
      reason: text,
    })
    .strict(),
  z
    .object({
      kind: z.literal("approval-request"),
      approval: codexChatApprovalSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("approval-decision"),
      approvalId: sessionRequestIdSchema,
      decision,
    })
    .strict(),
  z
    .object({
      kind: z.literal("approval-resolved"),
      approvalId: sessionRequestIdSchema,
      source: z.enum(["serverRequest/resolved", "turn/completed"]),
    })
    .strict(),
]) satisfies z.ZodType<CodexChatEvent>;
export const codexChatPrivateEventSchema = z
  .object({
    kind: z.literal("coding-chat"),
    provider: z.literal("codex"),
    version: z.literal(CODEX_APP_SERVER_VERSION),
    event: nativeEvent,
  })
  .strict() satisfies z.ZodType<CodexChatPrivateEvent>;
export const codexChatDecisionIntentSchema = z
  .object({
    kind: z.literal("coding-chat-decision"),
    provider: z.literal("codex"),
    version: z.literal(CODEX_APP_SERVER_VERSION),
    requestHash: sessionRequestHashSchema,
    receipt: codexChatDecisionReceiptSchema,
  })
  .strict() satisfies z.ZodType<CodexChatDecisionIntent>;
