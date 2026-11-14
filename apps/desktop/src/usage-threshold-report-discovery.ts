import { workspaceKey } from "../../../scripts/projects/scope";
import { providerReadinessPageSchema } from "../../../scripts/providers/protocol";
import { normalizeUsageWindow } from "../../../scripts/providers/readiness";
import type { InboxUsageRule } from "../../../types/inbox-usage";
import type { ProviderUsageWindow } from "../../../types/provider-readiness";
import {
  usageThresholdJson,
  usageThresholdOriginalSchema,
} from "../../../types/usage-threshold-settings";

export interface UsageThresholdReportsInput {
  data: unknown;
  loading: boolean;
  failed: boolean;
  stale: boolean;
  now: number;
}
export interface ReportedUsageChoice {
  readonly key: string;
  readonly provider: InboxUsageRule["provider"];
  readonly selector: Readonly<InboxUsageRule["selector"]>;
  readonly value: number;
  readonly total: number | null;
  readonly observedAt: string;
  readonly resetAt: string | null;
}
export interface UsageThresholdReportDiscovery {
  readonly status:
    | "ready"
    | "partial"
    | "empty"
    | "loading"
    | "unavailable"
    | "stale";
  readonly asOf: string | null;
  readonly choices: readonly ReportedUsageChoice[];
  readonly message: string;
}
function result(
  status: UsageThresholdReportDiscovery["status"],
  asOf: string | null = null,
  choices: ReportedUsageChoice[] = [],
): UsageThresholdReportDiscovery {
  const message = {
    ready:
      "Captured reported fields are available for a local draft. These fields do not verify account identity or continuity.",
    partial:
      "Some reported fields are unknown, stale, inconsistent or ambiguous and cannot be selected. Missing usage is not zero.",
    empty:
      "No selectable reported fields were supplied. Usage is not assumed to be zero.",
    loading:
      "Reported fields are being checked. No current selection is available yet.",
    unavailable:
      "Reported fields could not be verified. Missing usage is not zero.",
    stale:
      "Reported fields are stale. Check provider reports before selecting a current field.",
  }[status];
  return Object.freeze({
    status,
    asOf,
    choices: Object.freeze(choices),
    message,
  });
}
const measures = (window: ProviderUsageWindow) => [
  window.reported,
  window.used,
  window.remaining,
  window.total,
  window.percentUsed,
  window.observedAt,
  window.resetAt,
  window.durationMs,
];
/** Captured selector discovery only; never provider coverage, account continuity or mutation authority. */
export function discoverUsageThresholdReports(
  workspace: string,
  input: UsageThresholdReportsInput,
): UsageThresholdReportDiscovery {
  try {
    const { data, loading, failed, stale, now } = input;
    if (loading) return result("loading");
    if (failed || !Number.isFinite(now)) return result("unavailable");
    if (stale) return result("stale");
    const binding = usageThresholdOriginalSchema.shape.workspace.parse(
      workspaceKey(workspace),
    );
    const page = providerReadinessPageSchema.parse(data);
    if (workspaceKey(page.workspace) !== binding || page.problems.length)
      return result("unavailable");
    const age = now - Date.parse(page.asOf);
    if (!Number.isFinite(age) || age < 0) return result("unavailable");
    if (age > 30000) return result("stale");
    const identity = (provider: string, window: ProviderUsageWindow) =>
      usageThresholdJson([
        provider,
        window.kind,
        window.unit,
        window.source,
        window.label,
        window.reported.basis,
      ]);
    const counts = new Map<string, number>();
    for (const provider of page.providers)
      for (const window of provider.usage) {
        const key = identity(provider.provider, window);
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    const choices: ReportedUsageChoice[] = [];
    let rejected = false;
    for (const provider of page.providers)
      for (const window of provider.usage) {
        if (window.kind === "local-counted") continue;
        const key = identity(provider.provider, window);
        const value = window.reported.value,
          observedAt = window.observedAt;
        if (
          provider.stale ||
          window.stale ||
          counts.get(key) !== 1 ||
          (window.source !== "provider-cli" &&
            window.source !== "provider-api") ||
          value === null ||
          observedAt === null ||
          Date.parse(observedAt) > now ||
          (window.unit === "percent" && value > 100) ||
          (window.reported.total !== null &&
            window.reported.total > 0 &&
            value > window.reported.total) ||
          (window.kind === "subscription-window" && window.resetAt === null) ||
          (window.resetAt !== null && Date.parse(window.resetAt) <= now)
        ) {
          rejected = true;
          continue;
        }
        const normalized = normalizeUsageWindow(
          {
            id: window.id,
            label: window.label,
            kind: window.kind,
            unit: window.unit,
            basis: window.reported.basis,
            value,
            total: window.reported.total,
            observedAt,
            resetAt: window.resetAt,
            durationMs: window.durationMs,
            source: window.source,
            reason: null,
          },
          now,
        );
        if (
          normalized.stale ||
          usageThresholdJson(measures(normalized)) !==
            usageThresholdJson(measures(window))
        ) {
          rejected = true;
          continue;
        }
        choices.push(
          Object.freeze({
            key,
            provider: provider.provider,
            selector: Object.freeze({
              kind: window.kind,
              unit: window.unit,
              source: window.source,
              label: window.label,
              basis: window.reported.basis,
            }),
            value,
            total: window.reported.total,
            observedAt,
            resetAt: window.resetAt,
          }),
        );
      }
    choices.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    return result(
      rejected ? "partial" : choices.length ? "ready" : "empty",
      page.asOf,
      choices,
    );
  } catch {
    return result("unavailable");
  }
}
