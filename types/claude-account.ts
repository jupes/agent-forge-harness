interface ClaudeAccountBase {
  kind: "coding-account";
  provider: "claude";
  version: string;
  id: string;
  /** Hearth receipt time, not a provider's clock or a claim of current freshness. */
  observedAt: string;
}
export interface ClaudeUsageLimit {
  kind: string;
  group: string;
  percent: number;
  resets_at: string | null;
  scope?:
    | {
        model?: { display_name: string } | null | undefined;
        surface?: { display_name: string } | null | undefined;
      }
    | null
    | undefined;
  severity?: string | null | undefined;
  is_active?: boolean | null | undefined;
}
export type ClaudeAccountReport = ClaudeAccountBase &
  (
    | {
        source: "claude.system.init";
        report: {
          apiKeySource:
            | "ANTHROPIC_API_KEY"
            | "apiKeyHelper"
            | "/login managed key"
            | "none"
            | "user"
            | "project"
            | "org"
            | "temporary"
            | "oauth";
        };
      }
    | {
        source: "claude.auth_status";
        report: {
          isAuthenticating: boolean;
          hasError: boolean;
          outputOmitted: true;
        };
      }
    | {
        source: "claude.rate_limit_event";
        report: {
          status: "allowed" | "allowed_warning" | "rejected";
          utilization?: number | undefined;
          resetsAt?: number | undefined;
          resetUnit: "unreported";
          errorCode?: "credits_required" | undefined;
          canUserPurchaseCredits?: boolean | undefined;
          hasChargeableSavedPaymentMethod?: boolean | undefined;
        };
      }
    | {
        source: "claude.usage_report";
        report: {
          rate_limits: {
            limits: ClaudeUsageLimit[] | null;
            extra_usage?:
              | {
                  is_enabled: boolean;
                  monthly_limit: number | null;
                  used_credits: number | null;
                  utilization: number | null;
                  currency?: string | null | undefined;
                }
              | null
              | undefined;
          } | null;
        };
      }
  );
