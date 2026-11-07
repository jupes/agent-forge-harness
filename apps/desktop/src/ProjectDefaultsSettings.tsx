import type { JSX } from "preact";
import { Button } from "../../../docs/js/ds/Button";
import type { useProjectDefaults } from "./use-project-defaults";
import type { SmithsController } from "./use-smiths";

export function ProjectDefaultsSettings({
  projectId,
  archived,
  writesAllowed,
  settings,
  smiths,
}: {
  projectId: string;
  archived: boolean;
  writesAllowed: boolean;
  settings: ReturnType<typeof useProjectDefaults>;
  smiths: SmithsController;
}): JSX.Element {
  const state = settings.projects[projectId],
    config = smiths.view?.configuration;
  const saved = state?.catalog?.claudeSessionSmith,
    draft = state?.draft ?? saved ?? "";
  const choices =
    config?.data?.smiths.filter(
      (item) =>
        item.enabled && item.provider === "claude" && item.name.length <= 80,
    ) ?? [];
  const available = Boolean(config?.data && !config.error && !config.loading);
  const missing = Boolean(
    draft && !choices.some((item) => item.name === draft),
  );
  const busy = Boolean(settings.busy),
    editable = writesAllowed && !archived && !busy;
  return (
    <section
      class="af-project-keeper"
      aria-labelledby="project-defaults-heading"
    >
      <h3 id="project-defaults-heading">Session defaults</h3>
      <p>
        Choose the Smith to prefill fresh Claude session drafts. You can
        override it in the composer. Existing drafts, reviewed Starts and
        running sessions retain their selections.
      </p>
      <p>
        Source: project catalog · revision{" "}
        {state?.catalog?.revision ?? "unavailable"}
      </p>
      <p>
        Saved Claude default:{" "}
        <strong>{saved ?? "Inherit configured selection"}</strong>
      </p>
      {!saved && (
        <p>
          Selection source: configured default when it supports Claude;
          otherwise choose a Claude Smith in the composer.
        </p>
      )}
      {config?.loading && <p role="status">Loading configured Smiths…</p>}
      {config?.error && (
        <p role="alert">
          Configured Smiths could not be verified: {config.error}
        </p>
      )}
      {!available && (
        <Button
          onClick={() => void smiths.client?.refreshConfiguration()}
          disabled={Boolean(config?.loading)}
        >
          Refresh configured Smiths
        </Button>
      )}
      {missing && (
        <p role="status">
          The saved selection is unavailable or disabled. Choose an enabled
          Claude Smith or inherit configuration.
        </p>
      )}
      {state?.message && (
        <p role="status" aria-live="polite">
          {state.message}
        </p>
      )}
      <Button
        onClick={() => void settings.owner.review(projectId)}
        disabled={busy}
      >
        Check current session defaults
      </Button>
      {state?.needsReview && state.checked && (
        <Button
          onClick={() => settings.owner.confirmReview(projectId)}
          disabled={!editable}
        >
          I reviewed the current session defaults
        </Button>
      )}
      <form
        class="af-project-settings-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (editable && available && !missing)
            void settings.owner.save(projectId);
        }}
      >
        <label>
          Default Claude Smith
          <select
            value={draft}
            disabled={!editable || !available}
            onChange={(event) =>
              settings.owner.setDraft(projectId, event.currentTarget.value)
            }
          >
            <option value="">Inherit configured selection</option>
            {missing && (
              <option value={draft} disabled>
                {draft} (unavailable)
              </option>
            )}
            {choices.map((item) => (
              <option key={item.name} value={item.name}>
                {item.name} · {item.model}
              </option>
            ))}
          </select>
        </label>
        <button
          type="submit"
          class="af-btn af-btn-primary"
          disabled={
            !editable ||
            !available ||
            missing ||
            !state?.catalog ||
            state.needsReview ||
            state.draft === null
          }
        >
          {settings.busy === projectId
            ? "Saving or checking…"
            : "Save session defaults"}
        </button>
      </form>
    </section>
  );
}
