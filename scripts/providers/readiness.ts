import type {
  ProviderAuthentication,
  ProviderReadiness,
  ProviderUsageReport,
  ProviderUsageWindow,
} from "../../types/provider-readiness";

const nonnegative = (value: number | null): value is number =>
  value !== null && Number.isFinite(value) && value >= 0;
const validTime = (value: string | null) =>
  value !== null && Number.isFinite(Date.parse(value));

const semver =
  String.raw`(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?`;
const grokVersionOutput = new RegExp(
  `^grok (${semver}) \\(([0-9a-f]{12}|unknown)\\)(?: \\[(?:alpha|stable)\\])?\\n$`,
);

/** Parse the pinned Grok Build version emitter without treating semver alone as identity. */
export function parseGrokBuildVersionOutput(stdout: string): string | null {
  const match = grokVersionOutput.exec(stdout);
  return match?.[0].length === stdout.length ? stdout.slice(5, -1) : null;
}

/** Normalize the reported basis once; no unknown value is filled with zero. */
export function normalizeUsageWindow(
  report: ProviderUsageReport,
  now: number,
  maxAgeMs = 60000,
): ProviderUsageWindow {
  const total =
    nonnegative(report.total) && report.total > 0 ? report.total : null;
  const valid =
    nonnegative(report.value) && (total === null || report.value <= total);
  const value = valid ? report.value : null;
  const used =
    report.basis === "used"
      ? value
      : value !== null && total !== null
        ? total - value
        : null;
  const remaining =
    report.basis === "remaining"
      ? value
      : value !== null && total !== null
        ? total - value
        : null;
  const observedAt = validTime(report.observedAt) ? report.observedAt : null;
  const age = observedAt === null ? NaN : now - Date.parse(observedAt);
  const resetAt = validTime(report.resetAt) ? report.resetAt : null;
  return {
    id: report.id,
    label: report.label,
    kind: report.kind,
    unit: report.unit,
    used,
    remaining,
    total,
    percentUsed:
      report.kind !== "local-counted" && used !== null && total !== null
        ? (used / total) * 100
        : null,
    reported: { basis: report.basis, value, total },
    observedAt,
    resetAt,
    durationMs:
      nonnegative(report.durationMs) && report.durationMs > 0
        ? report.durationMs
        : null,
    source: report.source,
    stale:
      !Number.isFinite(age) ||
      age < -5000 ||
      age > maxAgeMs ||
      (report.kind === "subscription-window" &&
        resetAt !== null &&
        Date.parse(resetAt) <= now),
    reason:
      report.value !== null && !valid
        ? "The reported usage value could not be verified."
        : report.reason,
  };
}

export interface ReadinessObservation
  extends Omit<
    ProviderReadiness,
    "state" | "usage" | "usageReason" | "stale" | "smiths"
  > {
  reports: readonly ProviderUsageReport[];
  smiths: readonly ProviderReadiness["smiths"][number][];
}

function old(observedAt: string | null, now: number): boolean {
  const time = observedAt === null ? NaN : Date.parse(observedAt);
  return !Number.isFinite(time) || now - time > 60000 || time - now > 5000;
}

/** Independent observations remain visible even when the headline needs attention. */
export function buildProviderReadiness(
  observation: ReadinessObservation,
  now: number,
): ProviderReadiness {
  const { reports, ...facts } = observation;
  const usage = reports.map((report) => normalizeUsageWindow(report, now));
  const stale =
    old(facts.installation.checkedAt, now) ||
    (facts.authentication.observedAt !== null &&
      old(facts.authentication.observedAt, now));
  const exhausted = usage.some(
    (report) =>
      report.kind !== "local-counted" &&
      !report.stale &&
      report.remaining === 0 &&
      report.reported.value !== null,
  );
  const mode = facts.authentication.mode;
  const state = !facts.installation.found
    ? "not-installed"
    : !facts.installation.versionOk ||
        facts.installation.compatibility === "too-old" ||
        !facts.adapter.supported
      ? "degraded"
      : mode === "signed-out"
        ? "signed-out"
        : exhausted
          ? "exhausted"
          : mode === "subscription" || mode === "api-key"
            ? mode
            : "reporting-unavailable";
  return {
    ...facts,
    smiths: facts.smiths.map((smith) => ({ ...smith })),
    state,
    usage,
    stale,
    usageReason: usage.some((report) => report.kind !== "local-counted")
      ? null
      : "Allowance is not reported by this CLI status command. Local counts do not measure subscription room.",
  };
}

const unknownAuth = (): ProviderAuthentication => ({
  mode: "unknown",
  source: "unavailable",
  observedAt: null,
  reason:
    "Authentication could not be verified from this CLI status report. No task was run.",
});

/** Parse only documented authentication facts. Account and credential fields are discarded. */
export function parseClaudeAuthentication(
  text: string,
  exitCode: number,
  observedAt: string,
): ProviderAuthentication {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return unknownAuth();
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    return unknownAuth();
  const report = raw as Record<string, unknown>;
  const method = report.authMethod;
  if (exitCode === 1 && method === "none" && report.loggedIn === false)
    return {
      mode: "signed-out",
      source: "provider-cli",
      observedAt,
      reason: "The CLI reports signed out.",
    };
  if (exitCode !== 0 || report.loggedIn !== true) return unknownAuth();
  const mode =
    method === "claude.ai"
      ? "subscription"
      : method === "api_key" || method === "api_key_helper"
        ? "api-key"
        : method === "oauth_token" || method === "third_party"
          ? "signed-in"
          : null;
  return mode === null
    ? unknownAuth()
    : {
        mode,
        source: "provider-cli",
        observedAt,
        reason:
          "The CLI reports this sign-in route. No paid request or allowance check was made.",
      };
}

/** Codex documents exit0 as credentials present, not their validity or an allowance. */
export function parseCodexAuthentication(
  exitCode: number,
  observedAt: string,
): ProviderAuthentication {
  return exitCode === 0
    ? {
        mode: "signed-in",
        source: "provider-cli",
        observedAt,
        reason:
          "Codex reports saved credentials. Their route, validity and allowance have not been verified by a task.",
      }
    : unknownAuth();
}
