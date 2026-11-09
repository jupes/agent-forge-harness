import type { JSX } from "preact";
import { Button } from "../../../docs/js/ds/Button";
import { effectiveKeeperVisibility } from "../../../scripts/projects/project-keeper-protocol";
import type { useProjectKeeperSettings } from "./use-project-keeper-settings";
import type { SmithsController } from "./use-smiths";

export function ProjectKeeperSettings({
  projectId,
  archived,
  writesAllowed,
  settings,
  smiths,
}: {
  projectId: string;
  archived: boolean;
  writesAllowed: boolean;
  settings: ReturnType<typeof useProjectKeeperSettings>;
  smiths: SmithsController;
}): JSX.Element {
  const state = settings.projects[projectId];
  const config = smiths.view?.configuration;
  const inspection = config?.data;
  const saved = state?.catalog?.keeperSmith;
  const draft = state?.draft ?? saved ?? "";
  const savedAutonomy =
    state?.catalog?.keeperAutonomy ?? "propose-for-approval";
  const autonomy = state?.autonomyDraft ?? savedAutonomy;
  const available = Boolean(inspection && !config?.error && !config?.loading);
  const enabled = inspection?.smiths.filter((smith) => smith.enabled) ?? [];
  const missing = Boolean(
    draft && !enabled.some((smith) => smith.name === draft),
  );
  const busy = Boolean(settings.busy);
  const blocked = settings.owner.writesBlocked(projectId);
  const editable = Boolean(
    state?.catalog && writesAllowed && !archived && !busy && !blocked,
  );
  const canSaveKeeper = Boolean(
    editable &&
      available &&
      !missing &&
      state &&
      !state.needsReview &&
      (state.draft !== null || state.autonomyDraft !== null),
  );
  const canSaveVisibility = Boolean(
    editable && state && !state.needsReview && state.visibilityDraft !== null,
  );
  const savedVisibility = state?.catalog
    ? effectiveKeeperVisibility(state.catalog)
    : null;
  const visibility = state?.visibilityDraft ?? savedVisibility?.value ?? "";
  return (
    <section class="af-project-keeper" aria-labelledby="project-keeper-heading">
      <h3 id="project-keeper-heading">Forge Keeper</h3>
      <p>
        Choose the default Smith for future Keeper work. Existing conversations
        and reviewed selections keep their saved Smith.
      </p>
      <p class="af-project-keeper-provenance">
        Source: project catalog · revision{" "}
        {state?.catalog?.revision ?? "unavailable"}
      </p>
      <p>
        Saved project default:{" "}
        <strong>{saved ?? "Inherit configured default"}</strong>
      </p>
      <p>
        Saved autonomy:{" "}
        <strong>
          {savedAutonomy === "suggest-only"
            ? "Suggest only"
            : "Propose actions for my approval"}
        </strong>
        {!state?.catalog?.keeperAutonomy && " · source: default policy"}
      </p>
      {!saved && (
        <p>
          Inherited Smith: {inspection?.defaultSmith ?? "unavailable"} · source:{" "}
          {inspection?.defaultSource ?? "not reported"}
        </p>
      )}
      {config?.loading && <p role="status">Loading configured Smiths…</p>}
      {config?.error && (
        <p role="alert">
          Configured Smiths could not be verified: {config.error}
        </p>
      )}
      {available && !enabled.length && (
        <p role="status">No enabled Smiths are configured.</p>
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
          The selected Smith is unavailable or disabled. Choose an enabled Smith
          or inherit the configured default.
        </p>
      )}
      {blocked && (
        <p role="status">
          Resolve earlier Keeper changes or recovery storage before saving.
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
        Check current Keeper settings
      </Button>
      {state?.needsReview && state.checked && (
        <Button
          onClick={() => settings.owner.confirmReview(projectId)}
          disabled={!editable}
        >
          I reviewed the current Keeper values
        </Button>
      )}
      <form
        class="af-project-settings-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (canSaveKeeper) void settings.owner.save(projectId);
        }}
      >
        <label>
          Keeper autonomy
          <select
            value={autonomy}
            disabled={!editable || !state?.catalog}
            onChange={(event) =>
              settings.owner.setAutonomyDraft(
                projectId,
                event.currentTarget.value === "suggest-only"
                  ? "suggest-only"
                  : "propose-for-approval",
              )
            }
          >
            <option value="suggest-only">Suggest only</option>
            <option value="propose-for-approval">
              Propose actions for my approval
            </option>
          </select>
        </label>
        <p>
          Suggest only keeps recommendations readable and blocks new proposal
          approvals and Starts. Already approved work and saved originals
          continue. Propose mode always requires your approval.
        </p>
        <label>
          Keeper Smith
          <select
            value={draft}
            disabled={!editable || !available}
            onChange={(event) =>
              settings.owner.setDraft(projectId, event.currentTarget.value)
            }
          >
            <option value="">
              Inherit configured default
              {inspection ? ` (${inspection.defaultSmith})` : ""}
            </option>
            {missing && (
              <option value={draft} disabled>
                {draft} (unavailable)
              </option>
            )}
            {enabled.map((smith) => (
              <option key={smith.name} value={smith.name}>
                {smith.name} · {smith.provider} · {smith.model}
              </option>
            ))}
          </select>
        </label>
        <button
          type="submit"
          class="af-btn af-btn-primary"
          disabled={!canSaveKeeper}
        >
          {settings.busy === projectId
            ? "Saving or checking…"
            : "Save Keeper settings"}
        </button>
      </form>
      <form
        class="af-project-settings-form"
        aria-label="Keeper visibility settings"
        onSubmit={(event) => {
          event.preventDefault();
          if (canSaveVisibility) void settings.owner.saveVisibility(projectId);
        }}
      >
        <h4>Keeper visibility</h4>
        <p class="af-project-keeper-provenance">
          Saved visibility:{" "}
          <strong>
            {savedVisibility
              ? savedVisibility.value === "conversation-only"
                ? "Conversation only"
                : "Project metadata"
              : "Unavailable"}
          </strong>
          {savedVisibility && (
            <>
              {" "}
              · source:{" "}
              {savedVisibility.source === "default-policy"
                ? "default policy"
                : "project catalog"}{" "}
              · revision {state?.catalog?.revision}
            </>
          )}
        </p>
        <p>
          Conversation only blocks new Keeper metadata reads, brief preparation
          and turns with new harness metadata. Your messages, basic project
          identity, existing provider context and reviewed summaries remain.
          Already admitted work continues, and saved originals stay readable.
          Visibility does not approve actions.
        </p>
        <label>
          Keeper visibility
          <select
            aria-label="Keeper visibility"
            value={visibility}
            disabled={!editable}
            onChange={(event) => {
              const value = event.currentTarget.value;
              if (
                editable &&
                (value === "project-metadata" || value === "conversation-only")
              )
                settings.owner.setVisibilityDraft(projectId, value);
            }}
          >
            {!savedVisibility && (
              <option value="" disabled>
                Check current settings first
              </option>
            )}
            <option value="project-metadata">Project metadata</option>
            <option value="conversation-only">Conversation only</option>
          </select>
        </label>
        <button
          type="submit"
          class="af-btn af-btn-primary"
          disabled={!canSaveVisibility}
        >
          {settings.busy === projectId
            ? "Saving or checking…"
            : "Save visibility"}
        </button>
      </form>
    </section>
  );
}
