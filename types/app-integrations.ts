import { z } from "zod";

if (typeof window !== "undefined") z.config({ jitless: true });
export const integrationClientSchema = z.enum(["claude", "codex", "cursor"]);
export type IntegrationClient = z.infer<typeof integrationClientSchema>;
export const integrationReasonSchema = z.enum([
  "native-unavailable",
  "disconnected",
  "unavailable",
  "unreadable",
  "unsupported",
  "foreign",
  "scope-changed",
  "expired",
  "busy",
  "recovery-unavailable",
  "authorization-unavailable",
  "invalid-response",
  "cancelled",
]);
export type IntegrationReason = z.infer<typeof integrationReasonSchema>;
const requestId = z.string().uuid();
const scopeKey = z.string().regex(/^[a-f0-9]{64}$/);
const moment = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const identity = { client: integrationClientSchema, requestId, scopeKey };
export const integrationPendingSchema = z
  .object({ schemaVersion: z.literal(1), ...identity })
  .strict();
export type IntegrationPending = z.infer<typeof integrationPendingSchema>;
export const integrationReviewSchema = z.discriminatedUnion("state", [
  z
    .object({ state: z.literal("review"), ...identity, expiresAt: moment })
    .strict(),
  z
    .object({
      state: z.literal("configured"),
      client: integrationClientSchema,
      scopeKey,
      observedAt: moment,
    })
    .strict(),
  z.object({ state: z.literal("pending"), ...identity }).strict(),
]);
export type IntegrationReview = Extract<
  z.infer<typeof integrationReviewSchema>,
  { state: "review" }
>;
export const integrationOutcomeSchema = z
  .object({
    ...identity,
    state: z.enum(["not-attempted", "confirmed", "unknown"]),
    reason: integrationReasonSchema.nullable(),
  })
  .strict();
export const integrationAuthorizationSchema = z
  .object({
    schemaVersion: z.literal(1),
    requestId,
    client: integrationClientSchema,
    authorized: z.literal(true),
  })
  .strict();
export function integrationEnvelope<T extends z.ZodType>(data: T) {
  return z.union([
    z.object({ ok: z.literal(true), data, error: z.null() }).strict(),
    z
      .object({
        ok: z.literal(false),
        data: z.null(),
        error: integrationReasonSchema,
      })
      .strict(),
  ]);
}
