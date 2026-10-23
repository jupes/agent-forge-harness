import { z } from "zod";
import type { ClaudeAccountReport } from "../../types/claude-account";

if (typeof window !== "undefined") z.config({ jitless: true });
const text = z
  .string()
  .min(1)
  .max(200)
  .refine((value) => !value.includes("\0"));
const nonnegative = z.number().finite().nonnegative();
const label = z.object({ display_name: text }).strict();
const limit = z
  .object({
    kind: text,
    group: text,
    percent: nonnegative.max(100),
    resets_at: z.iso.datetime().nullable(),
    scope: z
      .object({
        model: label.nullable().optional(),
        surface: label.nullable().optional(),
      })
      .strict()
      .nullable()
      .optional(),
    severity: text.nullable().optional(),
    is_active: z.boolean().nullable().optional(),
  })
  .strict();
const authSource = z
  .object({
    apiKeySource: z.enum([
      "ANTHROPIC_API_KEY",
      "apiKeyHelper",
      "/login managed key",
      "none",
      "user",
      "project",
      "org",
      "temporary",
      "oauth",
    ]),
  })
  .strict();
const rateLimit = z
  .object({
    status: z.enum(["allowed", "allowed_warning", "rejected"]),
    utilization: nonnegative.optional(),
    resetsAt: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER)
      .optional(),
    resetUnit: z.literal("unreported"),
    errorCode: z.literal("credits_required").optional(),
    canUserPurchaseCredits: z.boolean().optional(),
    hasChargeableSavedPaymentMethod: z.boolean().optional(),
  })
  .strict();
const usage = z
  .object({
    rate_limits: z
      .object({
        limits: z.array(limit).max(128).nullable(),
        extra_usage: z
          .object({
            is_enabled: z.boolean(),
            monthly_limit: nonnegative.nullable(),
            used_credits: nonnegative.nullable(),
            utilization: nonnegative.nullable(),
            currency: text.nullable().optional(),
          })
          .strict()
          .nullable()
          .optional(),
      })
      .strict()
      .nullable(),
  })
  .strict();
const base = z.object({
  kind: z.literal("coding-account"),
  provider: z.literal("claude"),
  version: z
    .string()
    .max(100)
    .regex(/^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/),
  id: text,
  observedAt: z.iso.datetime(),
});
export const claudeAccountReportSchema: z.ZodType<ClaudeAccountReport> = z
  .union([
    base
      .extend({ source: z.literal("claude.system.init"), report: authSource })
      .strict(),
    base
      .extend({
        source: z.literal("claude.auth_status"),
        report: z
          .object({
            isAuthenticating: z.boolean(),
            hasError: z.boolean(),
            outputOmitted: z.literal(true),
          })
          .strict(),
      })
      .strict(),
    base
      .extend({
        source: z.literal("claude.rate_limit_event"),
        report: rateLimit,
      })
      .strict(),
    base
      .extend({ source: z.literal("claude.usage_report"), report: usage })
      .strict(),
  ])
  .refine(
    (value) => new TextEncoder().encode(JSON.stringify(value)).length <= 65_536,
  );
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const bad = () =>
  new Error(
    "The Claude account report did not match the private coding protocol.",
  );
/** Invoked only for real incoming CLI packets; it performs no request, auth probe or provider call. */
export function claudeAccountReports(input: {
  version: string;
  observedAt: string;
  value: Record<string, unknown>;
}): ClaudeAccountReport[] {
  const value = input.value;
  let source: ClaudeAccountReport["source"], report: unknown;
  if (
    value.type === "system" &&
    value.subtype === "init" &&
    value.apiKeySource !== undefined
  ) {
    source = "claude.system.init";
    report = { apiKeySource: value.apiKeySource };
  } else if (value.type === "auth_status") {
    if (value.error !== undefined && typeof value.error !== "string")
      throw bad();
    source = "claude.auth_status";
    report = {
      isAuthenticating: value.isAuthenticating,
      hasError: typeof value.error === "string" && value.error.length > 0,
      outputOmitted: true,
    };
  } else if (value.type === "rate_limit_event") {
    if (!record(value.rate_limit_info)) throw bad();
    const raw = value.rate_limit_info;
    source = "claude.rate_limit_event";
    report = {
      status: raw.status,
      resetUnit: "unreported",
      ...(raw.utilization === undefined
        ? {}
        : { utilization: raw.utilization }),
      ...(raw.resetsAt === undefined ? {} : { resetsAt: raw.resetsAt }),
      ...(raw.errorCode === undefined ? {} : { errorCode: raw.errorCode }),
      ...(raw.canUserPurchaseCredits === undefined
        ? {}
        : { canUserPurchaseCredits: raw.canUserPurchaseCredits }),
      ...(raw.hasChargeableSavedPaymentMethod === undefined
        ? {}
        : {
            hasChargeableSavedPaymentMethod:
              raw.hasChargeableSavedPaymentMethod,
          }),
    };
  } else if (value.type === "assistant" && value.usage_report !== undefined) {
    if (!record(value.usage_report)) throw bad();
    source = "claude.usage_report";
    report = { rate_limits: value.usage_report.rate_limits };
  } else return [];
  const parsed = claudeAccountReportSchema.safeParse({
    kind: "coding-account",
    provider: "claude",
    version: input.version,
    id: typeof value.uuid === "string" ? value.uuid : source,
    observedAt: input.observedAt,
    source,
    report,
  });
  if (!parsed.success) throw bad();
  return [parsed.data];
}
/** A server may expose this metadata projection; no prompt, auth-flow output or transcript leaves it. */
export function latestClaudeAccountReports(
  frames: readonly { event: unknown }[],
) {
  const result: {
    authSource: Extract<
      ClaudeAccountReport,
      { source: "claude.system.init" }
    > | null;
    authFlow: Extract<
      ClaudeAccountReport,
      { source: "claude.auth_status" }
    > | null;
    rateLimit: Extract<
      ClaudeAccountReport,
      { source: "claude.rate_limit_event" }
    > | null;
    usage: Extract<
      ClaudeAccountReport,
      { source: "claude.usage_report" }
    > | null;
  } = { authSource: null, authFlow: null, rateLimit: null, usage: null };
  for (const frame of frames) {
    const parsed = claudeAccountReportSchema.safeParse(frame.event);
    if (!parsed.success) continue;
    const event = parsed.data;
    if (event.source === "claude.system.init") result.authSource = event;
    else if (event.source === "claude.auth_status") result.authFlow = event;
    else if (event.source === "claude.rate_limit_event")
      result.rateLimit = event;
    else result.usage = event;
  }
  return result;
}
