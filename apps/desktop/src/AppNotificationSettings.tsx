import { Button } from "../../../docs/js/ds/Button";
import { DEFAULT_APP_NOTIFICATION_POLICY } from "../../../scripts/projects/app-notifications-protocol";
import type { createAppNotificationClient } from "./app-notifications-client";

const time = (minute: number) =>
  `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
const minute = (value: string) => {
  const parts = value.split(":").map(Number);
  return (parts[0] ?? NaN) * 60 + (parts[1] ?? NaN);
};
export function AppNotificationSettings({
  client,
  connected,
}: {
  client: ReturnType<typeof createAppNotificationClient>;
  connected: boolean;
}) {
  const state = client.state,
    current =
      state.draft ?? state.current?.policy ?? DEFAULT_APP_NOTIFICATION_POLICY;
  const edit = (patch: Partial<typeof current>) =>
    client.edit({ ...current, ...patch });
  return (
    <section
      class="af-project-settings"
      aria-labelledby="app-notification-heading"
    >
      <h2 id="app-notification-heading">App notifications</h2>
      <p>
        Applies to every project on this computer. Project event preferences and
        explicit window permission are also required. Turning interruptions off
        never removes Activity, Inbox items or approval actions.
      </p>
      <p>
        Source: {state.current?.source ?? "unavailable"} · revision{" "}
        {state.current?.revision ?? "unavailable"}. Quiet hours use this
        computer’s local time, including daylight saving changes.
      </p>
      <p role="status" aria-live="polite">
        {state.message}
      </p>
      <Button disabled={state.busy} onClick={() => void client.check()}>
        Check app notification settings
      </Button>
      <form
        class="af-project-settings-form"
        onSubmit={(e) => {
          e.preventDefault();
          void client.save();
        }}
      >
        <label>
          <input
            type="checkbox"
            checked={current.enabled}
            disabled={!connected || state.busy || !state.current}
            onChange={(e) => edit({ enabled: e.currentTarget.checked })}
          />
          Allow app interruptions
        </label>
        <label>
          <input
            type="checkbox"
            checked={current.quietHours !== null}
            disabled={!connected || state.busy || !state.current}
            onChange={(e) =>
              edit({
                quietHours: e.currentTarget.checked
                  ? { startMinute: 1320, endMinute: 480 }
                  : null,
              })
            }
          />
          Use quiet hours
        </label>
        {current.quietHours && (
          <>
            <label>
              Quiet hours start
              <input
                type="time"
                value={time(current.quietHours.startMinute)}
                disabled={state.busy || !connected}
                onInput={(e) =>
                  edit({
                    quietHours: {
                      ...current.quietHours!,
                      startMinute: minute(e.currentTarget.value),
                    },
                  })
                }
              />
            </label>
            <label>
              Quiet hours end
              <input
                type="time"
                value={time(current.quietHours.endMinute)}
                disabled={state.busy || !connected}
                onInput={(e) =>
                  edit({
                    quietHours: {
                      ...current.quietHours!,
                      endMinute: minute(e.currentTarget.value),
                    },
                  })
                }
              />
            </label>
            <p>
              End is excluded. An end earlier than the start continues into the
              next day; matching times are invalid.
            </p>
          </>
        )}
        <button
          class="af-btn af-btn-primary"
          type="submit"
          disabled={
            !connected ||
            state.busy ||
            !state.current ||
            !state.draft ||
            state.unknownRevision !== null
          }
        >
          Save app notification settings
        </button>
      </form>
      <p>
        In the Windows desktop tray, choose “Keep running when window closes
        (this launch)” to keep the current window and its notification
        permission alive. Open returns to that window; Quit asks before closing
        its hearth. Other app settings are not available here yet.
      </p>
    </section>
  );
}
