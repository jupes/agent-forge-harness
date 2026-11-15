import { useEffect, useRef, useState } from "preact/hooks";
import { operatorPost } from "../../../docs/js/operator";
import { version } from "../../../package.json";
import { createNativeUpdateClient } from "./native-update-client";

function nativeBridge() {
  try {
    const internals: unknown = Reflect.get(window, "__TAURI_INTERNALS__");
    if (
      !internals ||
      (typeof internals !== "object" && typeof internals !== "function")
    )
      return null;
    const invoke: unknown = Reflect.get(internals, "invoke");
    if (typeof invoke !== "function") return null;
    return (request: unknown): Promise<unknown> =>
      Promise.resolve(
        Reflect.apply(invoke, internals, ["native_update", { request }]),
      );
  } catch {
    return null;
  }
}
const labels = {
  unconfigured: "Update publishing is not configured for this build.",
  available:
    "A newer Windows package is available. Download it before reviewing installation.",
  current: "The signed update channel reports no newer supported package.",
  downloaded:
    "The package signature and signed version were verified. Installation has not started.",
  "install-unknown":
    "The original installation outcome is unconfirmed. Check that exact outcome before another installation.",
  "version-observed":
    "This version or a newer version is running. The original attempt record is retained.",
  unavailable: "No verified Windows update package is ready.",
  expired: "The prepared update expired. Check the signed channel again.",
  "not-attempted":
    "The installer was not launched. Check the signed channel to prepare another update.",
};
export function AppNativeUpdateSettings({ connected }: { connected: boolean }) {
  const [, changed] = useState(0),
    connection = useRef(connected);
  connection.current = connected;
  const [client] = useState(() => {
    let storage: Storage | null = null;
    try {
      storage = window.localStorage;
    } catch {
      /* Native journals remain authoritative. */
    }
    const key = "agent-forge:native-update:v1";
    return createNativeUpdateClient({
      currentVersion: version,
      connected: () => connection.current && nativeBridge() !== null,
      newId: () => crypto.randomUUID(),
      changed: () => changed((n) => n + 1),
      native: (request) => {
        const bridge = nativeBridge();
        if (!bridge) return Promise.reject(Error("native-unavailable"));
        return bridge(request);
      },
      authorize: async (request) => {
        const response = await operatorPost(
          "/__agent-forge/app-settings/native-updates/authorize",
          request,
          { maxBodyBytes: 2048 },
        );
        if (!response.ok) throw Error("authorization-unavailable");
        return response.json();
      },
      storage: {
        load() {
          const raw = storage?.getItem(key);
          if (!raw) return null;
          if (raw.length > 2048) throw Error("recovery-unavailable");
          try {
            return JSON.parse(raw);
          } catch {
            throw Error("recovery-unavailable");
          }
        },
        save(value) {
          if (!storage) throw Error("recovery-unavailable");
          if (value === null) storage.removeItem(key);
          else {
            const raw = JSON.stringify(value);
            storage.setItem(key, raw);
            if (storage.getItem(key) !== raw)
              throw Error("recovery-unavailable");
          }
        },
      },
    });
  });
  useEffect(() => {
    if (connected && nativeBridge()) void client.refresh();
    else client.cancel();
  }, [client, connected]);
  useEffect(() => () => client.dispose(), [client]);
  const state = client.state,
    result = state.result,
    available = connected && nativeBridge() !== null,
    disabled = !available || state.busy;
  return (
    <section class="af-app-hearth" aria-labelledby="native-updates-heading">
      <h4 id="native-updates-heading">Install signed updates</h4>
      <p>
        Windows app version: <code>{version}</code>.
      </p>
      {!available && (
        <p role="status">
          Open the connected Windows desktop app to prepare a signed update.
        </p>
      )}
      <p role={state.error ? "alert" : "status"} aria-live="polite">
        {state.busy
          ? "Working on the signed update…"
          : (state.error ??
            (result
              ? labels[result.state]
              : "Signed updates have not been checked."))}
      </p>
      {result?.version && (
        <p>
          Prepared version: <code>{result.version}</code>.
        </p>
      )}
      {state.unknown ? (
        <div>
          <p>
            Installation will not be sent again. The original native record is
            the source for recovery.
          </p>
          <button
            type="button"
            class="af-btn af-btn-secondary"
            disabled={disabled}
            onClick={() => {
              void client.refresh();
            }}
          >
            Check original installation outcome
          </button>
        </div>
      ) : (
        <div>
          <button
            type="button"
            class="af-btn af-btn-secondary"
            disabled={disabled || result?.state === "unconfigured"}
            onClick={() => {
              void client.check();
            }}
          >
            Check signed package
          </button>{" "}
          {result?.state === "available" && (
            <button
              type="button"
              class="af-btn af-btn-secondary"
              disabled={disabled}
              onClick={() => {
                void client.download();
              }}
            >
              Download signed update
            </button>
          )}{" "}
          {result?.state === "downloaded" && !state.review && (
            <button
              type="button"
              class="af-btn af-btn-secondary"
              disabled={disabled}
              onClick={() => client.review()}
            >
              Review installation
            </button>
          )}
        </div>
      )}
      {state.review && (
        <div role="group" aria-label="Review update installation">
          <p>
            Install version <code>{result?.version}</code>? Forge will stop its
            owned Hearth, close and open the Windows installer. Finish or stop
            active work before continuing.
          </p>
          <button
            type="button"
            class="af-btn af-btn-primary"
            disabled={disabled}
            onClick={() => {
              void client.confirm();
            }}
          >
            Install update and close Forge
          </button>{" "}
          <button
            type="button"
            class="af-btn af-btn-secondary"
            disabled={state.busy}
            onClick={() => client.cancel()}
          >
            Cancel installation
          </button>
        </div>
      )}
    </section>
  );
}
