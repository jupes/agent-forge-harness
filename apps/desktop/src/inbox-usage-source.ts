import { z } from "zod";
import { workspaceKey } from "../../../scripts/projects/scope";
import { providerReadinessPageSchema } from "../../../scripts/providers/protocol";
import { normalizeUsageWindow } from "../../../scripts/providers/readiness";
import { inboxDispositionStoredOriginalSchema } from "../../../types/inbox";
import type { ProviderUsageWindow } from "../../../types/provider-readiness";
import {
  type ProviderReadinessPage,
  READINESS_PROVIDERS,
} from "../../../types/provider-readiness";
import type {
  InboxSourceFactBase,
  InboxSourceRead,
} from "./inbox-bead-shift-source";
import type { InboxDispositionScope } from "./inbox-dispositions-client";

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
export interface InboxUsageFact extends InboxSourceFactBase {
  sourceKind: "usage-threshold";
  status: "pending";
  sourceIdentity: { ruleId: string; provider: InboxUsageRule["provider"] };
  quantity: {
    value: number;
    unit: InboxUsageRule["selector"]["unit"];
    basis: InboxUsageRule["selector"]["basis"];
    comparison: InboxUsageRule["comparison"];
    threshold: number;
    resetAt: string | null;
  };
  limitation: string;
}
export interface InboxUsageProjectionInput {
  scope: InboxDispositionScope;
  sourceGeneration: number;
  catalogRevision: number;
  now: number;
  configuration: InboxSourceRead<InboxUsageRulesDocument>;
  providers: InboxSourceRead<ProviderReadinessPage>;
}
export interface InboxUsageProjection {
  scope: InboxDispositionScope;
  sourceGeneration: number;
  catalogRevision: number;
  configurationRevision: number | null;
  facts: readonly InboxUsageFact[];
  coverage: InboxSourceRead<unknown>["coverage"];
  diagnostics: readonly string[];
}
type Pair = {
  configuration: InboxUsageRulesDocument | null;
  providers: ProviderReadinessPage | null;
};
type Crossing = {
  rule: InboxUsageRule;
  window: ProviderUsageWindow;
  value: number;
};
const diagnostic = "Configured reported usage could not be verified.";
const limitation =
  "Account identity and continuity are not verified; this notice describes a captured provider report.";

/** Pure captured-rule projection, not configuration persistence or Inbox coverage. */
export async function projectInboxUsageSource(
  input: InboxUsageProjectionInput,
): Promise<InboxUsageProjection> {
  const scope = { ...input.scope },
    sourceGeneration = input.sourceGeneration,
    catalogRevision = input.catalogRevision,
    now = input.now;
  const coverage = [input.configuration.coverage, input.providers.coverage].map(
    (value) => ({ ...value }),
  );
  const capture = <T>(
    schema: { parse(value: unknown): T },
    value: unknown,
  ): T | null => {
    try {
      return freeze(structuredClone(schema.parse(value)));
    } catch {
      return null;
    }
  };
  const snapshot = (prior: boolean): Pair => ({
    configuration: capture(
      inboxUsageRulesDocumentSchema,
      prior ? input.configuration.lastVerified : input.configuration.raw,
    ),
    providers: capture(
      providerReadinessPageSchema,
      prior ? input.providers.lastVerified : input.providers.raw,
    ),
  });
  // Capture both complete pairs and all caller provenance before hashing awaits.
  const currentPair = snapshot(false),
    priorPair = snapshot(true);
  const epochsValid = [sourceGeneration, catalogRevision].every(
    (value) => Number.isSafeInteger(value) && value >= 0,
  );
  const join = (
    pair: Pair,
    historical: boolean,
  ): {
    configuration: InboxUsageRulesDocument;
    crossings: Crossing[];
  } | null => {
    const config = pair.configuration,
      page = pair.providers;
    if (
      !config ||
      !page ||
      !epochsValid ||
      !Number.isFinite(now) ||
      config.projectId !== scope.projectId ||
      workspaceKey(config.workspace) !== workspaceKey(scope.workspace) ||
      workspaceKey(page.workspace) !== workspaceKey(scope.workspace) ||
      page.problems.length > 0
    )
      return null;
    const asOf = Date.parse(page.asOf),
      clock = historical ? asOf : now;
    if (asOf > now || (!historical && now - asOf > 30000)) return null;
    const crossings: Crossing[] = [];
    for (const rule of config.rules) {
      if (!rule.enabled) continue;
      const provider = page.providers.find(
        (value) => value.provider === rule.provider,
      );
      if (!provider || provider.stale) return null;
      const selector = rule.selector;
      // Native IDs are positional. A rule selects one complete semantic window.
      const matches = provider.usage.filter(
        (window) =>
          window.kind === selector.kind &&
          window.unit === selector.unit &&
          window.source === selector.source &&
          window.label === selector.label &&
          window.reported.basis === selector.basis,
      );
      const window = matches[0];
      if (
        matches.length !== 1 ||
        !window ||
        window.stale ||
        window.observedAt === null ||
        Date.parse(window.observedAt) > now
      )
        return null;
      const value = window.reported.value;
      if (
        value === null ||
        (window.unit === "percent" && value > 100) ||
        (window.reported.total !== null &&
          window.reported.total > 0 &&
          value > window.reported.total)
      )
        return null;
      const normalized = normalizeUsageWindow(
        {
          id: window.id,
          label: window.label,
          kind: window.kind,
          unit: window.unit,
          basis: window.reported.basis,
          value,
          total: window.reported.total,
          observedAt: window.observedAt,
          resetAt: window.resetAt,
          durationMs: window.durationMs,
          source: window.source,
          reason: null,
        },
        clock,
      );
      if (
        normalized.stale ||
        (window.kind === "subscription-window" && window.resetAt === null) ||
        (window.resetAt !== null && Date.parse(window.resetAt) <= clock)
      )
        return null;
      const measures = (item: ProviderUsageWindow) => [
        item.reported,
        item.used,
        item.remaining,
        item.total,
        item.percentUsed,
        item.observedAt,
        item.resetAt,
        item.durationMs,
      ];
      if (canonical(measures(window)) !== canonical(measures(normalized)))
        return null;
      const crossed =
        rule.comparison === "at-least"
          ? value >= rule.threshold
          : value <= rule.threshold;
      if (crossed) crossings.push({ rule, window, value });
    }
    return { configuration: config, crossings };
  };
  const current = join(currentPair, false);
  const fresh =
    current !== null &&
    coverage.every(
      (value) =>
        value.started &&
        value.settled &&
        value.complete &&
        value.fresh &&
        value.error === null,
    );
  const accepted = fresh ? current : join(priorPair, true);
  const result: InboxUsageProjection = {
    scope,
    sourceGeneration,
    catalogRevision,
    configurationRevision: accepted?.configuration.revision ?? null,
    facts: [],
    coverage: {
      started: coverage.every((value) => value.started),
      settled: coverage.every((value) => value.settled),
      complete: fresh,
      fresh,
      error: fresh ? null : diagnostic,
    },
    diagnostics: fresh ? [] : [diagnostic],
  };
  if (!accepted) return freeze(result);
  try {
    const facts: InboxUsageFact[] = [];
    for (const { rule, window, value } of accepted.crossings) {
      const identity = [
        "inbox-source-v1",
        workspaceKey(scope.workspace),
        scope.projectId,
        "usage-threshold",
        ["usage", rule.provider, rule.id],
      ];
      const stableItemId = await digest(identity);
      const sourceRevision = await digest([
        "inbox-revision-v1",
        identity,
        [
          rule,
          [
            window.kind,
            window.unit,
            window.source,
            window.label,
            window.reported.basis,
            value,
            window.reported.total,
            window.resetAt,
            window.durationMs,
          ],
        ],
      ]);
      facts.push(
        freeze<InboxUsageFact>({
          ...scope,
          sourceKind: "usage-threshold",
          status: "pending",
          stableItemId,
          sourceRevision,
          sourceIdentity: { ruleId: rule.id, provider: rule.provider },
          quantity: {
            value,
            unit: rule.selector.unit,
            basis: rule.selector.basis,
            comparison: rule.comparison,
            threshold: rule.threshold,
            resetAt: window.resetAt,
          },
          title: "Reported usage threshold",
          detail:
            rule.provider +
            " reported " +
            value +
            " " +
            rule.selector.unit +
            " " +
            rule.selector.basis +
            "; configured threshold " +
            rule.comparison +
            " " +
            rule.threshold +
            ".",
          fresh,
          complete: fresh,
          resolved: false,
          unresolvedReason:
            "No independent retained-original resolution witness was supplied.",
          limitation,
        }),
      );
    }
    result.facts = facts;
  } catch {
    result.coverage = {
      ...result.coverage,
      complete: false,
      fresh: false,
      error: diagnostic,
    };
    result.diagnostics = [diagnostic];
  }
  return freeze(result);
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, child]) => JSON.stringify(key) + ":" + canonical(child))
        .join(",") +
      "}"
    );
  return JSON.stringify(value) ?? "null";
}
async function digest(value: unknown): Promise<string> {
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonical(value)),
  );
  return (
    "sha256:" +
    Array.from(new Uint8Array(hash), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("")
  );
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
