import {
  type ProviderReadinessPage,
  READINESS_PROVIDERS,
} from "../../types/provider-readiness";
import { buildProviderReadiness } from "./readiness";

/** Explicit synthetic UI reports. These are never used by a production inspector. */
export function providerReadinessFixture(
  workspace: string,
  projectId: string,
): ProviderReadinessPage {
  const asOf = new Date().toISOString(),
    now = Date.parse(asOf);
  return {
    workspace,
    asOf,
    problems: [],
    providers: READINESS_PROVIDERS.map((provider, index) =>
      buildProviderReadiness(
        {
          provider,
          name:
            ["Claude", "Codex", "Gemini", "Grok", "OpenRouter"][index] ??
            provider,
          installation: {
            found: true,
            versionOk: true,
            path: `/fixture/${provider}`,
            version: "2.1.296",
            checkedAt: asOf,
            compatibility: "supported",
            reason: null,
          },
          authentication: {
            mode:
              index === 0
                ? "subscription"
                : index === 1 || index === 2
                  ? "api-key"
                  : "unknown",
            source: index < 3 ? "provider-cli" : "unavailable",
            observedAt: asOf,
            reason: "Synthetic reported sign-in route.",
          },
          adapter: {
            supported: index !== 4,
            reason: index === 4 ? "Deferred OpenCode/ACP route." : null,
          },
          signIn: {
            nativeAvailable: false,
            command:
              index === 0
                ? "claude auth login"
                : index === 1
                  ? "codex login"
                  : null,
            reason: index > 1 ? "Verified sign-in control unavailable." : null,
          },
          smiths: [],
          reports:
            index < 3
              ? [
                  {
                    id: "fixture-week",
                    label: "Fixture weekly allowance",
                    kind: "subscription-window",
                    unit: "percent",
                    basis: "remaining",
                    value: index === 2 ? 0 : 60,
                    total: 100,
                    observedAt: asOf,
                    resetAt: null,
                    durationMs: 604800000,
                    source: "provider-cli",
                    reason: "Synthetic browser fixture, not account data.",
                  },
                ]
              : [],
        },
        now,
      ),
    ),
    localUsage: {
      since: new Date(now - 604800000).toISOString(),
      through: asOf,
      source: "Counted locally · synthetic session totals",
      reason: "Partial reported totals. Missing prices stay unknown.",
      projects: [
        {
          projectId,
          name: "Alpha",
          providers: [
            {
              provider: "claude",
              sessions: 1,
              inputTokens: 12,
              outputTokens: null,
              costUsd: null,
            },
          ],
        },
      ],
    },
  };
}
