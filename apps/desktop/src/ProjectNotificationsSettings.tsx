import { Button } from "../../../docs/js/ds/Button";
import {
  NO_PROJECT_NOTIFICATIONS,
  PROJECT_NOTIFICATION_EVENTS,
  type ProjectNotifications,
} from "../../../scripts/projects/project-notifications-protocol";
import type { NotificationControl } from "./notification-delivery";
import type { useProjectValueSettings } from "./use-project-value-settings";

const labels = {
  "stopped-shift": "Shift halted",
  "failed-gate": "Gate failed",
  "council-verdict": "Council verdict",
  "bead-approval": "Bead awaiting approval",
} as const;
export function ProjectNotificationsSettings({
  projectId,
  archived,
  writesAllowed,
  settings,
  delivery,
}: {
  delivery?: NotificationControl | undefined;
  projectId: string;
  archived: boolean;
  writesAllowed: boolean;
  settings: ReturnType<typeof useProjectValueSettings<ProjectNotifications>>;
}) {
  const state = settings.projects[projectId],
    current = state?.draft ?? state?.catalog?.value ?? NO_PROJECT_NOTIFICATIONS;
  const editable =
    writesAllowed && !archived && !settings.busy && Boolean(state?.catalog);
  return (
    <section
      class="af-project-keeper"
      aria-labelledby="project-notifications-heading"
    >
      <h3 id="project-notifications-heading">Notifications</h3>
      <p>
        Choose which events may interrupt you when desktop notifications are
        available. Activity, Inbox and approval actions remain available when
        interruptions are off.
      </p>
      {delivery && (
        <div>
          <p role="status" aria-live="polite">
            {delivery.message}
          </p>
          <Button
            onClick={() =>
              delivery.enabled ? delivery.pause() : void delivery.enable()
            }
          >
            {delivery.enabled
              ? "Pause window interruptions"
              : "Enable window interruptions"}
          </Button>
          <p>
            Window control · resets when the window closes. While enabled, only
            new opted-in halts, failed gates, council verdicts and beads
            awaiting approval for the selected project notify, including while
            hidden. Keep this window open. Tray delivery is not available yet.
            App-wide interruption and quiet-hour controls are in Settings. Only
            verified events from this workspace are reported; unavailable
            sources may omit events.
          </p>
        </div>
      )}
      <p>
        Source: project catalog · revision{" "}
        {state?.catalog?.revision ?? "unavailable"}. Projects without saved
        preferences do not interrupt.
      </p>
      {state?.message && (
        <p role="status" aria-live="polite">
          {state.message}
        </p>
      )}
      <Button
        disabled={Boolean(settings.busy)}
        onClick={() => void settings.owner.review(projectId)}
      >
        Check current notification preferences
      </Button>
      {state?.needsReview && state.checked && (
        <Button
          disabled={!editable}
          onClick={() => settings.owner.confirmReview(projectId)}
        >
          I reviewed the current notification preferences
        </Button>
      )}
      <form
        class="af-project-settings-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (editable && state?.draft && !state.needsReview)
            void settings.owner.save(projectId);
        }}
      >
        {PROJECT_NOTIFICATION_EVENTS.map((kind) => (
          <label key={kind}>
            <input
              type="checkbox"
              aria-label={labels[kind]}
              checked={current[kind]}
              disabled={!editable}
              onChange={(event) =>
                settings.owner.edit(projectId, {
                  ...current,
                  [kind]: event.currentTarget.checked,
                })
              }
            />
            {labels[kind]}
            <small>
              {state?.catalog?.value[kind] ? "Saved: on" : "Saved: off"}
            </small>
          </label>
        ))}
        <button
          type="submit"
          class="af-btn af-btn-primary"
          disabled={!editable || !state?.draft || state.needsReview}
        >
          Save notification preferences
        </button>
      </form>
    </section>
  );
}
