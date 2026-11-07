import type { JSX } from "preact";
import { Button } from "../../../docs/js/ds/Button";
import type { ProjectDefaultKey } from "../../../scripts/projects/project-defaults-protocol";
import type { useProjectDefaults } from "./use-project-defaults";
import type { SmithsController } from "./use-smiths";

const providers = [
  { provider: "claude", label: "Claude", field: "claudeSessionSmith" },
  { provider: "codex", label: "Codex", field: "codexSessionSmith" },
  { provider: "gemini", label: "Gemini", field: "geminiSessionSmith" },
] as const;
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
  const value = (key: ProjectDefaultKey): string => {
    if (
      key === "claudeSessionSmith" &&
      state?.draft !== null &&
      state?.draft !== undefined
    )
      return state.draft;
    if (state?.extraDraft && Object.hasOwn(state.extraDraft, key))
      return state.extraDraft[key] ?? "";
    return state?.catalog?.[key] ?? "";
  };
  const choices = (provider: string) =>
    config?.data?.smiths.filter(
      (item) =>
        item.enabled && item.provider === provider && item.name.length <= 80,
    ) ?? [];
  const available = Boolean(config?.data && !config.error && !config.loading);
  const edited = (key: ProjectDefaultKey) =>
    (key === "claudeSessionSmith" &&
      state?.draft !== null &&
      state?.draft !== undefined) ||
    Boolean(state?.extraDraft && Object.hasOwn(state.extraDraft, key));
  const needsSmiths = providers.some(
    ({ field }) => edited(field) && Boolean(value(field)),
  );
  const invalid = providers.some(
    ({ provider, field }) =>
      edited(field) &&
      Boolean(value(field)) &&
      !choices(provider).some((item) => item.name === value(field)),
  );
  const busy = Boolean(settings.busy),
    editable = writesAllowed && !archived && !busy;
  const dirty = Boolean(
    state && (state.draft !== null || state.extraDraft !== null),
  );
  const canSave =
    editable &&
    Boolean(state?.catalog) &&
    dirty &&
    !state?.needsReview &&
    !invalid &&
    (!needsSmiths || available);
  return (
    <section
      class="af-project-keeper"
      aria-labelledby="project-defaults-heading"
    >
      <h3 id="project-defaults-heading">Session defaults</h3>
      <p>
        Choose the starting selections for fresh ordinary session drafts. You
        can override them in the composer. Existing drafts, reviewed Starts and
        running sessions retain their selections.
      </p>
      <p>
        Source: project catalog · revision{" "}
        {state?.catalog?.revision ?? "unavailable"}
      </p>
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
          if (canSave) void settings.owner.save(projectId);
        }}
      >
        {providers.map(({ provider, label, field }) => {
          const selected = value(field),
            options = choices(provider);
          const missing = Boolean(
            selected &&
              available &&
              !options.some((item) => item.name === selected),
          );
          return (
            <div key={provider}>
              <p>
                {"Saved " + label + " default: "}
                <strong>
                  {state?.catalog?.[field] ?? "Inherit configured selection"}
                </strong>
              </p>
              {missing && (
                <p role="status">
                  The {label} selection is unavailable or disabled. Choose
                  another Smith or inherit configuration before using that
                  provider.
                </p>
              )}
              <label>
                {"Default " + label + " Smith"}
                <select
                  value={selected}
                  disabled={!editable || !available}
                  onChange={(event) =>
                    settings.owner.setDefault(
                      projectId,
                      field,
                      event.currentTarget.value || null,
                    )
                  }
                >
                  <option value="">Inherit configured selection</option>
                  {missing && (
                    <option value={selected} disabled>
                      {selected} (unavailable)
                    </option>
                  )}
                  {options.map((item) => (
                    <option key={item.name} value={item.name}>
                      {item.name} · {item.model}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          );
        })}
        <label>
          Where it runs
          <select
            value={value("sessionWhere")}
            disabled={!editable || !state?.catalog}
            onChange={(event) =>
              settings.owner.setDefault(
                projectId,
                "sessionWhere",
                event.currentTarget.value || null,
              )
            }
          >
            <option value="">Use composer default · main checkout</option>
            <option value="main">Main checkout</option>
            <option value="existing">Existing worktree</option>
            <option value="new">New worktree from a base</option>
          </select>
        </label>
        <p>
          New and existing worktrees still require an explicit selection. A new
          worktree is created only through the reviewed Create worktree action.
        </p>
        <label>
          Run as
          <select
            value={value("sessionRunAs")}
            disabled={!editable || !state?.catalog}
            onChange={(event) =>
              settings.owner.setDefault(
                projectId,
                "sessionRunAs",
                event.currentTarget.value || null,
              )
            }
          >
            <option value="">Use provider composer default</option>
            <option value="chat">Chat · multi-turn conversation</option>
            <option value="task">Task · one bounded run</option>
          </select>
        </label>
        <p>
          Inherited Run as: Chat for Claude, Task for Codex and Gemini. These
          defaults do not approve work or change provider permissions.
        </p>
        <button type="submit" class="af-btn af-btn-primary" disabled={!canSave}>
          {settings.busy === projectId
            ? "Saving or checking…"
            : "Save session defaults"}
        </button>
      </form>
    </section>
  );
}
