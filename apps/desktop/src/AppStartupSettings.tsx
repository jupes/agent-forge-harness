import { useEffect, useRef, useState } from "preact/hooks";
import { operatorPost, operatorRead } from "../../../docs/js/operator";
import { appStream, createRefetcher } from "../../../docs/js/use-stream";
import {
  type AppStartupState,
  createAppStartupClient,
} from "./app-startup-client";
import "./app-hearth.css";
export function AppStartupView({
  state,
  connected,
  editable,
  saveable,
  check,
  edit,
  save,
  discard,
}: {
  state: AppStartupState;
  connected: boolean;
  editable: boolean;
  saveable: boolean;
  check(): void;
  edit(enabled: boolean): void;
  save(): void;
  discard(): void;
}) {
  const data = state.data?.capability === "available" ? state.data : null;
  return (
    <section class="af-app-hearth" aria-labelledby="app-startup-heading">
      <h3 id="app-startup-heading">Launch at login</h3>
      <p>
        Applies to this Windows user across projects and Forge homes. At login,
        the foreground app opens the normal workspace chooser. This setting does
        not authorize a workspace or start an agent task.
      </p>
      <p>
        Windows can delay or disable startup apps. This status verifies
        registration, not a successful Windows login launch.
      </p>
      <button
        type="button"
        class="af-btn af-btn-secondary"
        disabled={!connected || state.busy}
        onClick={check}
      >
        Check startup registration
      </button>
      <p role={state.error ? "alert" : "status"} aria-live="polite">
        {state.busy
          ? "Checking or saving startup registration…"
          : (state.error ?? state.message)}
      </p>
      {!connected && (
        <p role="status">Reconnect before reviewing startup registration.</p>
      )}
      {state.storageProblem && (
        <p role="alert">
          The pending request cannot be preserved or verified in this window.
          Startup saves are held.
        </p>
      )}
      {state.data?.capability === "unsupported" && (
        <p>
          Startup registration is unavailable from this window. Use the
          installed Windows desktop app with a supported executable path.
        </p>
      )}
      {data && (
        <>
          <p>
            {!state.fresh || !connected
              ? "Showing last read values; they may be out of date. "
              : ""}
            Last read: <time dateTime={data.checkedAt}>{data.checkedAt}</time>.
          </p>
          <p>
            Current registration:{" "}
            {data.registration === "enabled"
              ? "Enabled for this installation."
              : data.registration === "disabled"
                ? "Not registered."
                : "An existing startup entry differs or cannot be verified. It has been left unchanged."}
          </p>
          {data.record.last && (
            <p>
              Latest Settings request{" "}
              <code>{data.record.last.request.requestId}</code>:{" "}
              {data.record.last.state === "pending"
                ? "unconfirmed; startup saves are held across restart"
                : data.record.last.state}
              . Only the latest receipt is retained.
            </p>
          )}
          {data.registration !== "conflict" && (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                save();
              }}
            >
              <label
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "8px",
                  minHeight: "32px",
                }}
              >
                <input
                  type="checkbox"
                  checked={state.draft ?? data.registration === "enabled"}
                  disabled={!editable || !connected}
                  onChange={(event) => edit(event.currentTarget.checked)}
                />
                Launch the foreground app at Windows login
              </label>
              <p>
                Changing the checkbox creates a draft. Save confirms the
                registration; Cancel writes nothing.
              </p>
              <div class="af-project-settings-actions">
                <button
                  type="submit"
                  class="af-btn af-btn-primary"
                  disabled={!saveable || !connected}
                >
                  Save startup setting
                </button>
                <button
                  type="button"
                  class="af-btn af-btn-secondary"
                  disabled={
                    state.draft === null || state.busy || !!state.pending
                  }
                  onClick={discard}
                >
                  Cancel startup draft
                </button>
              </div>
            </form>
          )}
        </>
      )}
      {state.pending && (
        <p role="alert">
          Request <code>{state.pending.requestId}</code> remains to be checked.
          Current registration alone does not confirm this request. Only its
          exact terminal receipt can resolve the outcome.
        </p>
      )}
    </section>
  );
}
export function AppStartupSettings({ connected }: { connected: boolean }) {
  const [, changed] = useState(0),
    connection = useRef(connected);
  connection.current = connected;
  const [client] = useState(() => {
    let storage: Storage | null = null;
    try {
      storage = window.sessionStorage;
    } catch {
      /* Unavailable preserved intent keeps writes held. */
    }
    return createAppStartupClient({
      storage,
      requestId: () => crypto.randomUUID(),
      canAct: () => connection.current,
      changed: () => changed((value) => value + 1),
      read: () =>
        operatorRead(
          "/__agent-forge/desktop/startup",
          {},
          { maxBodyBytes: 8192 },
        ),
      post: (request) =>
        operatorPost("/__agent-forge/desktop/startup", request, {
          maxBodyBytes: 8192,
        }),
    });
  });
  useEffect(() => {
    if (connected) void client.check();
  }, [client, connected]);
  useEffect(() => {
    const refetch = createRefetcher({ run: () => client.check() });
    const stop = appStream().watch(["operator.action"], () =>
      refetch.request(),
    );
    return () => {
      stop();
      refetch.dispose();
    };
  }, [client]);
  useEffect(() => () => client.dispose(), [client]);
  return (
    <AppStartupView
      state={client.state}
      connected={connected}
      editable={client.canEdit()}
      saveable={client.canSave()}
      check={() => {
        void client.check();
      }}
      edit={(value) => client.edit(value)}
      save={() => {
        void client.save();
      }}
      discard={() => client.discard()}
    />
  );
}
