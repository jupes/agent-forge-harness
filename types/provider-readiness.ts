export type UsageSource =
  | "provider-cli"
  | "provider-api"
  | "local-ledger"
  | "configuration"
  | "unavailable";
export interface ProviderUsageReport {
  id: string;
  label: string;
  kind: "subscription-window" | "api-balance" | "local-counted";
  unit: "percent" | "tokens" | "requests" | "usd";
  basis: "used" | "remaining";
  value: number | null;
  total: number | null;
  observedAt: string;
  resetAt: string | null;
  durationMs: number | null;
  source: UsageSource;
  reason: string | null;
}

/** Account allowance and locally counted work keep separate kinds and units. */
export interface ProviderUsageWindow {
  id: string;
  label: string;
  kind: ProviderUsageReport["kind"];
  unit: ProviderUsageReport["unit"];
  used: number | null;
  remaining: number | null;
  total: number | null;
  percentUsed: number | null;
  reported: {
    basis: ProviderUsageReport["basis"];
    value: number | null;
    total: number | null;
  };
  observedAt: string | null;
  resetAt: string | null;
  durationMs: number | null;
  source: UsageSource;
  stale: boolean;
  reason: string | null;
}

export const READINESS_PROVIDERS = [
  "claude",
  "codex",
  "gemini",
  "grok",
  "openrouter",
] as const;
export type ReadinessProvider = (typeof READINESS_PROVIDERS)[number];
export type ProviderAuthMode =
  | "unknown"
  | "signed-out"
  | "subscription"
  | "api-key"
  | "signed-in";
export interface ProviderAuthentication {
  mode: ProviderAuthMode;
  source: "provider-cli" | "unavailable";
  observedAt: string | null;
  /** Fixed diagnostic copy only; no vendor stdout, account identity or key. */
  reason: string | null;
}
export interface ProviderInstallation {
  found: boolean;
  versionOk: boolean;
  version: string | null;
  path: string | null;
  checkedAt: string;
  compatibility: "supported" | "too-old" | "unknown";
  reason: string | null;
}
export type ProviderReadinessState =
  | "not-installed"
  | "signed-out"
  | "subscription"
  | "api-key"
  | "exhausted"
  | "reporting-unavailable"
  | "degraded";
export interface ProviderReadiness {
  provider: ReadinessProvider;
  name: string;
  installation: ProviderInstallation;
  authentication: ProviderAuthentication;
  adapter: { supported: boolean; reason: string | null };
  signIn: { command: string | null; reason: string | null };
  state: ProviderReadinessState;
  usage: ProviderUsageWindow[];
  usageReason: string | null;
  smiths: { name: string; model: string; enabled: boolean }[];
  stale: boolean;
}
export interface ProviderReadinessPage {
  workspace: string;
  asOf: string;
  providers: ProviderReadiness[];
  problems: string[];
  localUsage: {
    since: string;
    through: string;
    source: string;
    reason: string;
    projects:
      | {
          projectId: string;
          name: string;
          providers: {
            provider: string;
            sessions: number;
            inputTokens: number | null;
            outputTokens: number | null;
            costUsd: number | null;
          }[];
        }[]
      | null;
  };
}
