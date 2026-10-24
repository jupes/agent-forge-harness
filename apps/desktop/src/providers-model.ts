import type {
  ProviderReadiness,
  ProviderReadinessPage,
  ProviderUsageWindow,
} from "../../../types/provider-readiness";

export function providerReportStale(
  data: ProviderReadinessPage | null,
  now: number,
): boolean {
  if (!data) return false;
  const age = now - Date.parse(data.asOf);
  return !Number.isFinite(age) || age > 30000 || age < -5000;
}

export const readinessLabel = (state: ProviderReadiness["state"]) =>
  ({
    "not-installed": "Not installed",
    "signed-out": "Signed out",
    subscription: "Subscription",
    "api-key": "API key",
    exhausted: "Exhausted",
    "reporting-unavailable": "Reporting unavailable",
    degraded: "Degraded",
  })[state];

export function providerUsageLabel(
  provider: ProviderReadiness | undefined,
): string {
  const reports =
    provider?.usage.filter((report) => report.kind !== "local-counted") ?? [];
  return reports.length
    ? reports
        .map(
          (report) =>
            `${report.label}: ${measure(report)}${report.stale ? " · stale" : ""}`,
        )
        .join(" · ")
    : "Usage — not reported";
}
function measure(report: ProviderUsageWindow): string {
  if (report.percentUsed !== null)
    return `${Math.round(report.percentUsed)}% used`;
  const quantity = report.remaining ?? report.used;
  if (quantity === null) return "—";
  const formatted =
    report.unit === "usd"
      ? `$${quantity.toFixed(2)}`
      : `${quantity.toLocaleString()} ${report.unit}`;
  return `${formatted} ${report.remaining !== null ? "remaining" : "used"}`;
}
