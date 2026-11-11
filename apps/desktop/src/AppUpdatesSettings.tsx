import { useEffect, useRef, useState } from "preact/hooks";
import { operatorPost } from "../../../docs/js/operator";
import { version } from "../../../package.json";
import {
  type AppUpdatesState,
  createAppUpdatesClient,
} from "./app-updates-client";
import "./app-hearth.css";
export function AppUpdatesView({
  state,
  check,
  connected,
}: {
  state: AppUpdatesState;
  check(): void;
  connected: boolean;
}) {
  const last = state.last;
  return (
    <section class="af-app-hearth" aria-labelledby="app-updates-heading">
      <h3 id="app-updates-heading">Updates</h3>
      <p>
        Bundled renderer version: <code>{version}</code>.
      </p>
      <p>
        Choose Check for updates to contact the official GitHub stable-release
        feed. Recent results may be reused for 60 seconds.
      </p>
      <button
        type="button"
        class="af-btn af-btn-secondary"
        disabled={state.busy || !connected}
        onClick={check}
      >
        Check for updates
      </button>
      <p role={state.error ? "alert" : "status"} aria-live="polite">
        {state.busy
          ? "Checking stable release information…"
          : (state.error ??
            (last
              ? "Release information checked."
              : "Updates have not been checked."))}
      </p>
      {!connected && (
        <p role="status">Reconnect to Hearth before checking updates.</p>
      )}
      {last && (
        <div>
          {(!state.fresh || !connected) && (
            <p role="status">
              Showing the last verified result; it may be out of date.
            </p>
          )}
          <p>
            Last verified check:{" "}
            <time dateTime={last.checkedAt}>{last.checkedAt}</time>.
          </p>
          <p>
            {last.state === "newer"
              ? "The reported stable release is newer than this renderer."
              : last.state === "equal"
                ? "This renderer version matches the reported stable release."
                : "This renderer is ahead of the reported stable release; it may be an unreleased build."}
          </p>
          <p>
            Reported stable tag: <code>{last.release.tag}</code>.
          </p>
          <label>
            Official release URL{" "}
            <input
              style={{
                width: "100%",
                boxSizing: "border-box",
                minHeight: "32px",
              }}
              type="text"
              readOnly
              value={last.release.url}
            />
          </label>
          <p>Copy this address into your browser to review the release.</p>
        </div>
      )}
      <p>
        Automatic installation is unavailable. This check downloads and installs
        no package. Release metadata does not verify package compatibility or
        integrity.
      </p>
    </section>
  );
}
export function AppUpdatesSettings({ connected }: { connected: boolean }) {
  const [, changed] = useState(0),
    connection = useRef(connected);
  connection.current = connected;
  const [client] = useState(() =>
    createAppUpdatesClient({
      post: () =>
        operatorPost(
          "/__agent-forge/app-settings/updates/check",
          {},
          { maxBodyBytes: 4096 },
        ),
      canCheck: () => connection.current,
      changed: () => changed((value) => value + 1),
    }),
  );
  useEffect(() => () => client.dispose(), [client]);
  return (
    <AppUpdatesView
      state={client.state}
      check={() => {
        void client.check();
      }}
      connected={connected}
    />
  );
}
