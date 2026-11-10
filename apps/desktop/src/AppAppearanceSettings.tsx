import { DEFAULT_APP_APPEARANCE } from "../../../scripts/projects/app-appearance-protocol";
import type { createAppAppearanceClient } from "./app-appearance-client";

export function AppAppearanceSettings({
  client,
  effective,
  connected,
}: {
  client: ReturnType<typeof createAppAppearanceClient>;
  effective: "dark" | "light";
  connected: boolean;
}) {
  const state = client.state,
    saved = state.current?.appearance ?? DEFAULT_APP_APPEARANCE,
    draft = state.draft ?? saved;
  const disabled =
    !connected ||
    state.busy ||
    !state.verified ||
    state.unknownRevision !== null;
  return (
    <section class="af-app-appearance" aria-labelledby="app-appearance-heading">
      <h3 id="app-appearance-heading">Appearance</h3>
      <p>
        Saved for this computer’s Forge home. Applies across projects and after
        relaunch.
      </p>
      <p>
        Source: {state.current?.source ?? "unavailable"} · revision{" "}
        {state.current?.revision ?? "unavailable"}. Saved theme: {saved.theme}.
        current appearance: {effective}. Density: {saved.density}.
      </p>
      <p role="status" aria-live="polite">
        {state.message}
      </p>
      <button
        type="button"
        class="af-btn af-btn-secondary"
        disabled={!connected || state.busy}
        onClick={() => void client.check()}
      >
        Check saved appearance
      </button>
      <form
        class="af-project-settings-form"
        onSubmit={(event) => {
          event.preventDefault();
          void client.save();
        }}
      >
        <label>
          Theme
          <select
            aria-label="Theme"
            value={draft.theme}
            disabled={disabled}
            onChange={(event) =>
              client.edit({
                ...draft,
                theme: event.currentTarget.value as typeof draft.theme,
              })
            }
          >
            <option value="dark">Dark</option>
            <option value="light">Light</option>
            <option value="system">System</option>
          </select>
        </label>
        <label>
          Density
          <select
            aria-label="Density"
            value={draft.density}
            disabled={disabled}
            onChange={(event) =>
              client.edit({
                ...draft,
                density: event.currentTarget.value as typeof draft.density,
              })
            }
          >
            <option value="compact">Compact</option>
            <option value="comfortable">Comfortable</option>
          </select>
        </label>
        <p>
          System follows the Windows appearance setting. Changes take effect
          after Save confirms the values.
        </p>
        <div class="af-project-settings-actions">
          <button
            class="af-btn af-btn-primary"
            type="submit"
            disabled={!client.canSave()}
          >
            Save appearance
          </button>
          <button
            class="af-btn af-btn-secondary"
            type="button"
            disabled={disabled || !state.draft}
            onClick={() => client.discard()}
          >
            Discard appearance draft
          </button>
        </div>
      </form>
    </section>
  );
}
