import { z } from "zod";
import {
  type ProviderReadinessPage,
  READINESS_PROVIDERS,
} from "../../types/provider-readiness";

if (typeof window !== "undefined") z.config({ jitless: true });
const text = z
  .string()
  .min(1)
  .max(2048)
  .refine((value) => !/[\p{Cc}\p{Cs}]/u.test(value));
const number = z.number().finite().nonnegative();
const nullable = number.nullable();
const time = z.iso.datetime();
const source = z.enum([
  "provider-cli",
  "provider-api",
  "local-ledger",
  "configuration",
  "unavailable",
]);
const usage = z
  .object({
    id: text,
    label: text,
    kind: z.enum(["subscription-window", "api-balance", "local-counted"]),
    unit: z.enum(["percent", "tokens", "requests", "usd"]),
    used: nullable,
    remaining: nullable,
    total: nullable,
    percentUsed: number.max(100).nullable(),
    reported: z
      .object({
        basis: z.enum(["used", "remaining"]),
        value: nullable,
        total: nullable,
      })
      .strict(),
    observedAt: time.nullable(),
    resetAt: time.nullable(),
    durationMs: nullable,
    source,
    stale: z.boolean(),
    reason: text.nullable(),
  })
  .strict();
export const providerReadinessPageSchema: z.ZodType<ProviderReadinessPage> = z
  .object({
    workspace: text,
    asOf: time,
    providers: z
      .array(
        z
          .object({
            provider: z.enum(READINESS_PROVIDERS),
            name: text,
            installation: z
              .object({
                found: z.boolean(),
                versionOk: z.boolean(),
                version: text.nullable(),
                path: text.nullable(),
                checkedAt: time,
                compatibility: z.enum(["supported", "too-old", "unknown"]),
                reason: text.nullable(),
              })
              .strict(),
            authentication: z
              .object({
                mode: z.enum([
                  "unknown",
                  "signed-out",
                  "subscription",
                  "api-key",
                  "signed-in",
                ]),
                source: z.enum(["provider-cli", "unavailable"]),
                observedAt: time.nullable(),
                reason: text.nullable(),
              })
              .strict(),
            adapter: z
              .object({ supported: z.boolean(), reason: text.nullable() })
              .strict(),
            signIn: z
              .object({ command: text.nullable(), reason: text.nullable() })
              .strict(),
            state: z.enum([
              "not-installed",
              "signed-out",
              "subscription",
              "api-key",
              "exhausted",
              "reporting-unavailable",
              "degraded",
            ]),
            usage: z.array(usage).max(32),
            usageReason: text.nullable(),
            smiths: z
              .array(
                z
                  .object({ name: text, model: text, enabled: z.boolean() })
                  .strict(),
              )
              .max(200),
            stale: z.boolean(),
          })
          .strict(),
      )
      .length(5)
      .refine((rows) => new Set(rows.map((row) => row.provider)).size === 5),
    problems: z.array(text).max(20),
    localUsage: z
      .object({
        since: time,
        through: time,
        source: text,
        reason: text,
        projects: z
          .array(
            z
              .object({
                projectId: text,
                name: text,
                providers: z
                  .array(
                    z
                      .object({
                        provider: text,
                        sessions: z.number().int().nonnegative(),
                        inputTokens: nullable,
                        outputTokens: nullable,
                        costUsd: nullable,
                      })
                      .strict(),
                  )
                  .max(100),
              })
              .strict(),
          )
          .max(200)
          .nullable(),
      })
      .strict(),
  })
  .strict();
