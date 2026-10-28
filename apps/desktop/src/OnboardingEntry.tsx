import type { JSX } from "preact";
import { Button } from "../../../docs/js/ds/Button";
import type {
  ProviderAuthentication,
  ProviderReadinessPage,
} from "../../../types/provider-readiness";
import { desktopHref } from "./navigation";
import { readinessLabel } from "./providers-model";

function authenticationLabel(mode: ProviderAuthentication["mode"]): string {
  switch (mode) {
    case "unknown":
      return "Not reported";
    case "signed-in":
      return "Saved credentials reported";
    case "signed-out":
      return "Signed out";
    case "api-key":
      return "API key";
    case "subscription":
      return "Subscription";
  }
}

export function OnboardingEntry({
  providers,
  providerStale,
  disabled,
  onSkip,
}: {
  providers: ProviderReadinessPage | null;
  providerStale: boolean;
  disabled: boolean;
  onSkip(): void;
}): JSX.Element {
  return (
    <section class="af-onboarding-entry" aria-label="First-run setup">
      <div>
        <h2>Set up Agent Forge</h2>
        <p>
          Provider checks and sign-in are optional. Review providers now or
          skip to create your first project.
        </p>
      </div>
      {!providers ? (
        <p role="status">
          No readiness report. Provider status is unknown.
        </p>
      ) : (
        <section
          class="af-onboarding-providers"
          aria-label="Provider readiness snapshot"
        >
          <p class="af-onboarding-asof">
            {providerStale ? "Last-known provider report" : "Provider report"} ·{" "}
            <time dateTime={providers.asOf}>
              {new Date(providers.asOf).toLocaleString()}
            </time>
          </p>
          {providers.problems.map((problem) => (
            <p class="af-onboarding-problem" key={problem}>
              {problem}
            </p>
          ))}
          <ul class="af-onboarding-provider-list">
            {providers.providers.map((provider) => (
              <li key={provider.provider}>
                <strong>{provider.name}</strong>
                <span>{readinessLabel(provider.state)}</span>
                <span class="af-onboarding-provider-detail">
                  CLI {provider.installation.found ? "found" : "not found"} ·
                  {" "}Sign-in {authenticationLabel(provider.authentication.mode)}
                </span>
                {(provider.stale || providerStale) && (
                  <span class="af-onboarding-provider-detail">
                    Last-known observation; recheck before relying on it.
                  </span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
      <div class="af-onboarding-actions">
        <Button
          href={desktopHref({
            destination: "providers",
            projectId: null,
            selection: null,
          })}
        >
          Review providers &amp; usage
        </Button>
        <Button variant="primary" disabled={disabled} onClick={onSkip}>
          Skip provider setup
        </Button>
      </div>
      <p class="af-onboarding-brief-note">
        After project creation, Overview lets you request the first Keeper
        brief as a separate action.
      </p>
    </section>
  );
}
