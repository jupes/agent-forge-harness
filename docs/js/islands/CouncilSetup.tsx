import type { ProviderReadiness } from "../../../scripts/council/providers";
import type { CouncilProfile } from "../../../scripts/council/types";

export type ProfileChoice = Pick<
  CouncilProfile,
  "id" | "title" | "seats" | "chair" | "depth" | "maxEstimatedUsd"
> & {
  path: string;
  readiness: ProviderReadiness[];
};

export type CouncilDraft = {
  sourceType: string;
  source: string;
  profilePath: string;
  budget: string;
  redactSecrets: boolean;
};
type Props = {
  draft: CouncilDraft;
  profiles: ProfileChoice[];
  active: boolean;
  starting: boolean;
  onChange: (patch: Partial<CouncilDraft>) => void;
  onStart: () => Promise<void>;
  onCancel: () => Promise<void>;
};
export function CouncilSetup({
  draft,
  profiles,
  active,
  starting,
  onChange,
  onStart,
  onCancel,
}: Props) {
  const { sourceType, source, profilePath, budget, redactSecrets } = draft;
  const profile = profiles.find((item) => item.path === profilePath);
  const ready = profile?.readiness.every((entry) => entry.configured) ?? false;
  return (
    <section className="panel" aria-label="New review">
      <h2>What should the council review?</h2>
      <div className="form-grid">
        <label>
          Source
          <select
            value={sourceType}
            onChange={(event) =>
              onChange({ sourceType: event.currentTarget.value })
            }
            disabled={active}
          >
            <option value="text">Paste a document</option>
            <option value="pr">GitHub pull request</option>
            <option value="plan">Local Markdown plan</option>
            <option value="file">Local research or text file</option>
          </select>
        </label>
        <label>
          Council profile
          <select
            value={profilePath}
            onChange={(event) => {
              const path = event.currentTarget.value;
              onChange({
                profilePath: path,
                budget: String(
                  profiles.find((choice) => choice.path === path)
                    ?.maxEstimatedUsd ?? 3,
                ),
              });
            }}
            disabled={active}
          >
            {profiles.map((choice) => (
              <option key={choice.path} value={choice.path}>
                {choice.title}
              </option>
            ))}
          </select>
        </label>
        <label className="wide">
          {sourceType === "text"
            ? "Document or question"
            : sourceType === "pr"
              ? "PR number or GitHub URL"
              : "File path within this workspace"}
          <textarea
            value={source}
            onInput={(event) => onChange({ source: event.currentTarget.value })}
            placeholder={
              sourceType === "text"
                ? "Paste the work, its goals, and the evidence the reviewers should consider…"
                : sourceType === "pr"
                  ? "https://github.com/owner/repo/pull/123"
                  : "plans/drafts/my-plan.md"
            }
            disabled={active}
          />
        </label>
        <label>
          Run budget (USD)
          <input
            type="number"
            min="0"
            step="0.1"
            value={budget}
            onInput={(event) => onChange({ budget: event.currentTarget.value })}
            disabled={active}
          />
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={redactSecrets}
            onChange={(event) =>
              onChange({ redactSecrets: event.currentTarget.checked })
            }
            disabled={active}
          />{" "}
          Redact detected secrets; otherwise reject
        </label>
      </div>
      <div className="readiness">
        {profile?.readiness.map((entry) => (
          <span
            key={entry.provider}
            className={`pill${entry.configured ? "" : " warning"}`}
          >
            {entry.provider}:{" "}
            {entry.configured
              ? "configured"
              : (entry.error ?? `needs ${entry.missing.join(", ")}`)}
          </span>
        ))}
      </div>
      <p className="provider-note">
        {profile?.seats.every((seat) => seat.provider === "fake")
          ? "Demo profile: simulated feedback, no API keys or model charges."
          : "Your selected providers receive the supplied review material. Configure keys in the server environment; never paste them here."}
      </p>
      {profile?.readiness.some((entry) => entry.routing) && (
        <details>
          <summary>Gateway routing policy</summary>
          {profile.readiness.flatMap((entry) =>
            (entry.routing ?? []).map((routing) => (
              <p key={routing.seatId} className="muted">
                {routing.seatId}:{" "}
                {routing.only?.join(", ") ?? "any eligible endpoint"} · fallback{" "}
                {routing.allow_fallbacks ? "enabled" : "disabled"} · data
                collection {routing.data_collection} · zero-retention filter{" "}
                {routing.zdr ? "on" : "off"} · structured parameters required
              </p>
            )),
          )}
        </details>
      )}
      {profile &&
        [...profile.seats, profile.chair].some(
          (seat) => seat.provider === "openrouter",
        ) && (
          <p className="notice">
            One-key gateway: set OPENROUTER_API_KEY in the server environment.
            Review material goes through OpenRouter and its upstream providers.
            The profile controls retention filtering and fallback; inspect it
            before sending private work. Readiness checks configuration, not
            live availability.
          </p>
        )}
      <div className="actions">
        <button
          type="button"
          onClick={() => void onStart()}
          disabled={
            active ||
            starting ||
            !ready ||
            !source.trim() ||
            budget.trim() === "" ||
            !Number.isFinite(Number(budget)) ||
            Number(budget) < 0
          }
        >
          {starting ? "Starting…" : "Convene council"}
        </button>
        {active && (
          <button
            type="button"
            className="secondary"
            onClick={() => void onCancel()}
          >
            Stop review
          </button>
        )}
        <span className="muted">{profile?.depth ?? "balanced"} discussion</span>
      </div>
    </section>
  );
}
