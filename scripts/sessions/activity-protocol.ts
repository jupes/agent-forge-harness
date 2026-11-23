import { z } from "zod";
import type {
  ClaudeCodingUsageEvent,
  CodingActivityEvent,
  CodingOutcomeEvent,
  ReportedJson,
  ReportedText,
} from "../../types/session-activity";

if (typeof window !== "undefined") z.config({ jitless: true });

export const SESSION_ACTIVITY_LIMITS = {
  textBytes: 16_384,
  jsonBytes: 32_768,
  eventBytes: 65_536,
  aggregateBytes: 2_097_152,
  events: 4096,
  jsonDepth: 16,
  jsonNodes: 10_000,
  items: 128,
} as const;
const encoder = new TextEncoder();
const bytes = (value: string) => encoder.encode(value).length;
const text = z
  .string()
  .max(SESSION_ACTIVITY_LIMITS.textBytes)
  .refine(
    (value) =>
      !value.includes("\0") &&
      !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(
        value,
      ) &&
      bytes(value) <= SESSION_ACTIVITY_LIMITS.textBytes,
  );
const reported = z.object({ text, truncated: z.boolean() }).strict();
const version = z
  .string()
  .max(100)
  .regex(/^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/);
const id = z
  .string()
  .min(1)
  .max(200)
  .refine((value) => !value.includes("\0"));
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const integer = z.number().int().min(-2_147_483_648).max(2_147_483_647);
function jsonBound(value: unknown): "depth" | "nodes" | null {
  const pending = [{ value, depth: 0 }],
    seen = new WeakSet<object>();
  let nodes = 0;
  while (pending.length) {
    const next = pending.pop();
    if (!next) break;
    if (++nodes > SESSION_ACTIVITY_LIMITS.jsonNodes) return "nodes";
    if (next.depth > SESSION_ACTIVITY_LIMITS.jsonDepth) return "depth";
    const item = next.value;
    if (
      item === null ||
      typeof item === "string" ||
      typeof item === "boolean" ||
      (typeof item === "number" && Number.isFinite(item))
    )
      continue;
    if (
      typeof item !== "object" ||
      seen.has(item) ||
      (!Array.isArray(item) &&
        ![Object.prototype, null].includes(Object.getPrototypeOf(item)))
    )
      throw Error("Expected finite reported JSON data.");
    seen.add(item);
    for (const child of Object.values(item))
      pending.push({ value: child, depth: next.depth + 1 });
  }
  return null;
}
function clip(value: string, limit: number): string {
  let end = 0,
    used = 0;
  for (const character of value) {
    const size = bytes(character);
    if (used + size > limit) break;
    used += size;
    end += character.length;
  }
  return value.slice(0, end);
}
export function reportedText(value: string): ReportedText {
  const safe = value
    .replaceAll("\0", "�")
    .replace(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
      "�",
    );
  return {
    text: clip(safe, SESSION_ACTIVITY_LIMITS.textBytes),
    truncated:
      safe !== value || bytes(safe) > SESSION_ACTIVITY_LIMITS.textBytes,
  };
}
export function reportedJson(value: unknown): ReportedJson {
  const omitted = jsonBound(value);
  if (omitted) return { json: "", truncated: true, omitted };
  const json = JSON.stringify(value);
  if (bytes(json) > SESSION_ACTIVITY_LIMITS.jsonBytes)
    return {
      json: clip(json, SESSION_ACTIVITY_LIMITS.jsonBytes),
      truncated: true,
      omitted: "size",
    };
  return { json, truncated: false };
}
const json = z
  .object({
    json: z
      .string()
      .max(SESSION_ACTIVITY_LIMITS.jsonBytes)
      .refine((value) => bytes(value) <= SESSION_ACTIVITY_LIMITS.jsonBytes),
    truncated: z.boolean(),
    omitted: z.enum(["depth", "nodes", "size"]).optional(),
  })
  .strict()
  .refine((value) => {
    if (value.truncated) return true;
    if (value.omitted) return false;
    try {
      return jsonBound(JSON.parse(value.json)) === null;
    } catch {
      return false;
    }
  });
const state = z.enum(["running", "completed", "failed"]);

export { json as reportedJsonSchema, reported as reportedTextSchema };

const activity = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("reasoning"),
      content: reported,
      redacted: z.boolean(),
    })
    .strict()
    .refine((value) => !value.redacted || value.content.text === ""),
  z
    .object({
      kind: z.literal("tool"),
      toolId: id,
      name: id,
      state,
      input: json.optional(),
      output: json.optional(),
      error: reported.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("command"),
      command: reported,
      state,
      output: reported.optional(),
      exitCode: integer.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("files"),
      state,
      changes: z
        .array(
          z
            .object({
              path: z
                .string()
                .min(1)
                .max(4096)
                .refine((value) => !value.includes("\0")),
              operation: z.enum(["add", "delete", "update"]),
              diff: reported.optional(),
              additions: count.optional(),
              deletions: count.optional(),
            })
            .strict(),
        )
        .max(SESSION_ACTIVITY_LIMITS.items),
      truncated: z.boolean(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("plan"),
      steps: z
        .array(
          z
            .object({
              content: reported,
              state: z.enum(["incomplete", "in-progress", "completed"]),
            })
            .strict(),
        )
        .max(SESSION_ACTIVITY_LIMITS.items),
      truncated: z.boolean(),
    })
    .strict(),
  z.object({ kind: z.literal("structured-output"), output: json }).strict(),
  z
    .object({
      kind: z.literal("permission-denials"),
      denials: z
        .array(z.object({ toolId: id, name: id, input: json }).strict())
        .max(SESSION_ACTIVITY_LIMITS.items),
      truncated: z.boolean(),
    })
    .strict()
    .refine(
      (value) =>
        new Set(value.denials.map((item) => item.toolId)).size ===
        value.denials.length,
    ),
]);
export const codingActivitySchema: z.ZodType<CodingActivityEvent> = z
  .object({
    kind: z.literal("coding-activity"),
    provider: z.enum(["claude", "codex"]),
    version,
    id,
    source: z.enum([
      "claude.assistant",
      "claude.stream_event",
      "claude.user",
      "claude.result",
      "codex.item.started",
      "codex.item.updated",
      "codex.item.completed",
    ]),
    partial: z.boolean(),
    activity,
  })
  .strict()
  .refine(
    (value) =>
      value.source.startsWith(`${value.provider}.`) &&
      bytes(JSON.stringify(value)) <= SESSION_ACTIVITY_LIMITS.eventBytes &&
      (value.source !== "claude.result" ||
        ["structured-output", "permission-denials"].includes(
          value.activity.kind,
        )) &&
      (value.activity.kind !== "permission-denials" ||
        value.source === "claude.result") &&
      (value.provider !== "codex" ||
        value.activity.kind !== "structured-output") &&
      (value.source !== "claude.user" ||
        ["tool", "command", "files", "plan"].includes(value.activity.kind)),
  );
const authCodes = ["authentication_failed", "oauth_org_not_allowed"];
export const codingOutcomeSchema: z.ZodType<CodingOutcomeEvent> = z
  .object({
    kind: z.literal("coding-outcome"),
    provider: z.enum(["claude", "codex"]),
    version,
    code: z.enum([
      "completed",
      "stopped",
      "timed-out",
      "provider-error",
      "auth-error",
      "rate-limited",
      "cli-exit",
      "protocol-error",
      "storage-error",
    ]),
    exitCode: integer.nullable(),
    timedOut: z.boolean(),
    stopped: z.boolean(),
    message: reported.nullable(),
    stderrTail: reported,
    reportedCode: id.optional(),
    resetAt: z.iso.datetime().optional(),
  })
  .strict()
  .refine((value) => {
    if (value.timedOut) return value.code === "timed-out";
    if (value.stopped)
      return ["stopped", "protocol-error", "storage-error"].includes(
        value.code,
      );
    if (value.code === "timed-out" || value.code === "stopped") return false;
    if (value.code === "completed") return value.exitCode === 0;
    if (value.code === "auth-error")
      return (
        value.provider === "claude" &&
        authCodes.includes(value.reportedCode ?? "")
      );
    if (value.code === "rate-limited")
      return value.provider === "claude" && value.reportedCode === "rate_limit";
    return true;
  });
export const claudeCodingUsageSchema: z.ZodType<ClaudeCodingUsageEvent> = z
  .object({
    kind: z.literal("coding-usage"),
    provider: z.literal("claude"),
    source: z.literal("claude.result"),
    version,
    usage: z
      .object({
        inputTokens: count.optional(),
        outputTokens: count.optional(),
        cacheReadInputTokens: count.optional(),
        cacheCreationInputTokens: count.optional(),
      })
      .strict(),
    cumulativeEstimateUsd: z.number().finite().nonnegative().optional(),
    durationMs: count.optional(),
  })
  .strict();

/** Per-turn accounting. A limit poisons completion rather than silently dropping activity. */
export function createActivityBudget() {
  const budget = createPrivateReportBudget();
  return (event: CodingActivityEvent): CodingActivityEvent =>
    budget(codingActivitySchema.parse(event));
}
/** Helpers validate their own schemas; this shared counter includes account and usage reports too. */
export function createPrivateReportBudget() {
  let total = 0,
    count = 0;
  return <T>(event: T): T => {
    const size = bytes(JSON.stringify(event));
    if (
      ++count > SESSION_ACTIVITY_LIMITS.events ||
      (total += size) > SESSION_ACTIVITY_LIMITS.aggregateBytes
    )
      throw new Error(
        "The private coding activity exceeded its bounded turn limit.",
      );
    return event;
  };
}
