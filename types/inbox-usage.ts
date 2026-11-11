import { z } from "zod";
import { inboxDispositionStoredOriginalSchema } from "./inbox";
import { READINESS_PROVIDERS } from "./provider-readiness";

const safeNumber = z.number().finite().nonnegative();
const safeRevision = safeNumber.int().max(Number.MAX_SAFE_INTEGER);
export const inboxUsageRuleSchema = z
  .object({
    id: z.uuid().refine((value) => value === value.toLowerCase()),
    provider: z.enum(READINESS_PROVIDERS),
    enabled: z.boolean(),
    selector: z
      .object({
        kind: z.enum(["subscription-window", "api-balance"]),
        unit: z.enum(["percent", "tokens", "requests", "usd"]),
        source: z.enum(["provider-cli", "provider-api"]),
        label: z
          .string()
          .min(1)
          .max(2048)
          .refine((value) => !/[\p{Cc}\p{Cs}]/u.test(value)),
        basis: z.enum(["used", "remaining"]),
      })
      .strict(),
    comparison: z.enum(["at-least", "at-most"]),
    threshold: safeNumber,
  })
  .strict()
  .refine((rule) => rule.selector.unit !== "percent" || rule.threshold <= 100);
export const inboxUsageRulesDocumentSchema = z
  .object({
    projectId: inboxDispositionStoredOriginalSchema.shape.projectId,
    workspace: inboxDispositionStoredOriginalSchema.shape.workspace,
    revision: safeRevision,
    rules: z
      .array(inboxUsageRuleSchema)
      .max(100)
      .refine(
        (rules) => new Set(rules.map((rule) => rule.id)).size === rules.length,
      ),
  })
  .strict();
export type InboxUsageRule = z.infer<typeof inboxUsageRuleSchema>;
export type InboxUsageRulesDocument = z.infer<
  typeof inboxUsageRulesDocumentSchema
>;
