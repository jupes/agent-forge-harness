import type { JSX } from "preact";
import { Button } from "../../../docs/js/ds/Button";
import { PROJECT_COLOR_IDS, type ProjectRecord } from "../../../types/projects";
import type {
  GeneralCatalog,
  GeneralDraft,
  GeneralSettingsSnapshot,
  ProjectGeneralSettingsOwner,
} from "./project-general-settings-client";
import "./project-settings.css";

interface Props {
  projectId: string | null;
  project: ProjectRecord | null;
  catalog: GeneralCatalog | null;
  initialRevision: number | null;
  loading: boolean;
  error: string | null;
  stale: boolean;
  writesAllowed: boolean;
  owner: ProjectGeneralSettingsOwner;
  state: GeneralSettingsSnapshot;
  onRefresh(): void;
}

export function ProjectSettings({
  projectId,
  project,
  catalog,
  initialRevision,
  loading,
  error,
  stale,
  writesAllowed,
  owner,
  state,
  onRefresh,
}: Props): JSX.Element {
  const refreshCurrent = () => {
    if (projectId) void owner.review(projectId).finally(onRefresh);
    else onRefresh();
  };
  if (!project && !catalog && loading)
    return <p role="status">Loading project settings…</p>;
  if (error && !project)
    return (
      <section
        class="af-project-settings"
        aria-labelledby="project-settings-title"
      >
        <h2 id="project-settings-title">Project settings</h2>
        <p role="alert">{error}</p>
        {projectId && state.notices[projectId] && (
          <p role="status">{state.notices[projectId]}</p>
        )}
        <Button
          onClick={refreshCurrent}
          disabled={Boolean(state.sendingProjectId || state.checkingProjectId)}
        >
          Refresh current settings
        </Button>
      </section>
    );
  if (!project)
    return (
      <section
        class="af-project-settings"
        aria-labelledby="project-settings-title"
      >
        <h2 id="project-settings-title">Project settings</h2>
        <p role="status">This project is not in the current catalog.</p>
        {projectId && state.notices[projectId] && (
          <p role="status">{state.notices[projectId]}</p>
        )}
        <Button
          onClick={refreshCurrent}
          disabled={Boolean(state.sendingProjectId || state.checkingProjectId)}
        >
          Refresh current settings
        </Button>
      </section>
    );

  const currentCatalog = catalog;
  const current =
    currentCatalog?.project.id === project.id ? currentCatalog.project : null;
  if (!current || !currentCatalog)
    return (
      <section
        class="af-project-settings"
        aria-labelledby="project-settings-title"
      >
        <h2 id="project-settings-title">Project settings</h2>
        {state.projectionErrors[project.id] ? (
          <p role="alert">
            The General settings projection was rejected:{" "}
            {state.projectionErrors[project.id]}
          </p>
        ) : (
          <p role="status">
            Loading the validated General settings projection.
          </p>
        )}
        {(state.priorNotices[project.id] ?? []).map((prior, index) => (
          <p role="status" key={`${project.id}:${index}`}>
            {prior}
          </p>
        ))}
        {state.notices[project.id] && (
          <p role="status">{state.notices[project.id]}</p>
        )}
        <Button
          onClick={() => void owner.review(project.id)}
          disabled={Boolean(state.sendingProjectId || state.checkingProjectId)}
        >
          Refresh current settings
        </Button>
      </section>
    );
  const original = current.general;
  const draft: GeneralDraft = owner.draft(project.id, original);
  const message = state.notices[project.id] ?? "";
  const currentUnresolved = state.unresolved.filter(
    (intent) => intent.projectId === project.id,
  );
  const otherProjectId =
    state.unresolved.find((intent) => intent.projectId !== project.id)
      ?.projectId ??
    (state.sendingProjectId && state.sendingProjectId !== project.id
      ? state.sendingProjectId
      : null);
  const needsReview =
    state.reviewedProjectId !== project.id &&
    (state.reviewRequired[project.id] === true || currentUnresolved.length > 0);
  const busy = Boolean(state.sendingProjectId || state.checkingProjectId);
  const editable =
    writesAllowed && !project.archived && !otherProjectId && !busy;
  const set = (patch: Partial<GeneralDraft>) =>
    owner.setDraft(project.id, { ...draft, ...patch });

  return (
    <section
      class="af-project-settings"
      aria-labelledby="project-settings-title"
    >
      <header class="af-project-settings-heading">
        <div>
          <h2 id="project-settings-title">Project settings</h2>
          <p>General details for {current.general.name}.</p>
        </div>
      </header>
      <section aria-labelledby="project-general-heading">
        <h3 id="project-general-heading">General</h3>
        <p class="af-project-settings-provenance">
          Source:{" "}
          {currentCatalog.freshRead
            ? "current hearth project catalog read"
            : "last-known hearth project catalog"}{" "}
          · revision{" "}
          {currentCatalog.revision ?? initialRevision ?? "unavailable"} · record
          updated <time dateTime={current.updatedAt}>{current.updatedAt}</time>
        </p>
        {state.projectionErrors[project.id] && (
          <p role="alert">
            The latest project summary could not be projected:{" "}
            {state.projectionErrors[project.id]}. These values are last-known;
            refresh the General catalog before saving.
          </p>
        )}
        <Button
          onClick={() => void owner.review(project.id, currentCatalog.revision)}
          disabled={busy}
        >
          Refresh current settings
        </Button>
        <dl
          class="af-project-settings-current"
          aria-label="Current catalog values"
        >
          <div>
            <dt>Name</dt>
            <dd>{current.general.name}</dd>
          </div>
          <div>
            <dt>Description</dt>
            <dd>{current.general.description || "No description"}</dd>
          </div>
          <div>
            <dt>Icon</dt>
            <dd>{current.general.icon}</dd>
          </div>
          <div>
            <dt>Color</dt>
            <dd>{current.general.color ?? "No color"}</dd>
          </div>
        </dl>
        {project.archived && (
          <p role="status">
            This archived project is available for inspection; editing is
            disabled.
          </p>
        )}
        {!writesAllowed && !project.archived && (
          <p role="status">
            Reconnect to the hearth before changing project settings.
          </p>
        )}
        {stale && project && (
          <p role="status">
            Showing last-known catalog values. Refresh and compare before making
            changes.
          </p>
        )}
        {otherProjectId && (
          <p role="status">
            A General update for project {otherProjectId} is in progress or
            unresolved. Return to that project to check or review it before
            editing another project.
          </p>
        )}
        {(state.priorNotices[project.id] ?? []).map((prior, index) => (
          <p
            class="af-project-settings-notice"
            role="status"
            key={`${project.id}:${index}`}
          >
            {prior}
          </p>
        ))}
        {message && (
          <p
            class="af-project-settings-notice"
            role="status"
            aria-live="polite"
          >
            {message}
          </p>
        )}
        {needsReview && editable && (
          <div class="af-project-settings-review">
            <p>
              Compare the current catalog values above with your draft below. A
              check reads the catalog only; it does not resend an earlier
              request.
            </p>
            {state.checkedProjectId === project.id ? (
              <Button
                onClick={() => owner.confirmReview(project.id)}
                disabled={busy}
              >
                I reviewed the current values
              </Button>
            ) : (
              <Button
                onClick={() =>
                  void owner.review(project.id, currentCatalog.revision)
                }
                disabled={busy}
              >
                {currentUnresolved.length
                  ? "Check current settings"
                  : "Refresh current settings"}
              </Button>
            )}
          </div>
        )}
        <form
          class="af-project-settings-form"
          onSubmit={(event) => {
            event.preventDefault();
            void owner.save(
              project.id,
              currentCatalog.revision,
              original,
              draft,
            );
          }}
        >
          <label>
            Project name
            <input
              aria-label="Project name"
              maxLength={120}
              required
              value={draft.name}
              disabled={!editable}
              onInput={(event) => set({ name: event.currentTarget.value })}
            />
          </label>
          <label>
            Project description
            <textarea
              aria-label="Project description"
              maxLength={500}
              value={draft.description}
              disabled={!editable}
              onInput={(event) =>
                set({ description: event.currentTarget.value })
              }
            />
          </label>
          <label>
            Project icon
            <input
              aria-label="Project icon"
              maxLength={16}
              required
              value={draft.icon}
              disabled={!editable}
              onInput={(event) => set({ icon: event.currentTarget.value })}
            />
          </label>
          <label>
            Project color
            <select
              aria-label="Project color"
              value={draft.color ?? ""}
              disabled={!editable}
              onChange={(event) => {
                const value = event.currentTarget.value;
                if (value === "") set({ color: undefined });
                else {
                  const color = PROJECT_COLOR_IDS.find(
                    (item) => item === value,
                  );
                  if (color) set({ color });
                }
              }}
            >
              <option value="">No color</option>
              {PROJECT_COLOR_IDS.map((color) => (
                <option key={color} value={color}>
                  {color}
                </option>
              ))}
            </select>
          </label>
          <button
            class="af-btn af-btn-primary"
            type="submit"
            disabled={!editable || needsReview}
          >
            {state.sendingProjectId === project.id
              ? "Saving…"
              : "Save General settings"}
          </button>
        </form>
      </section>
    </section>
  );
}
