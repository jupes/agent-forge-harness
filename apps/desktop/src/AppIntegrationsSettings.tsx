import { useEffect, useRef, useState } from "preact/hooks";
import { operatorPost } from "../../../docs/js/operator";
import type {
  IntegrationClient,
  IntegrationPending,
  IntegrationReason,
} from "../../../types/app-integrations";
import {
  createAppIntegrationsClient,
  type IntegrationView,
} from "./app-integrations-client";
import "./app-hearth.css";
import "./app-integrations.css";
const labels: Record<IntegrationClient, string> = {
  claude: "Claude Code",
  codex: "Codex",
  cursor: "Cursor",
};
const reasons: Record<IntegrationReason, string> = {
  "native-unavailable": "Open the Windows desktop app to register a client.",
  disconnected: "Reconnect to Hearth before continuing.",
  unavailable: "The operation could not be confirmed.",
  unreadable: "This configuration could not be read safely.",
  unsupported: "This configuration location or filesystem is unsupported.",
  foreign:
    "An existing Forge entry differs. Review it in the client before changing it.",
  "scope-changed":
    "The reviewed configuration or workspace changed. Review it again.",
  expired: "This review expired. Review the configuration again.",
  busy: "Another registration is in progress.",
  "recovery-unavailable": "The original recovery record could not be verified.",
  "authorization-unavailable":
    "Your approval could not be recorded. No registration was requested.",
  "invalid-response": "The response could not be verified.",
  cancelled: "This registration was not attempted.",
};
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
        Reflect.apply(invoke, internals, ["mcp_registration", { request }]),
      );
  } catch {
    return null;
  }
}
function status(view: IntegrationView): string {
  switch (view.phase) {
    case "idle":
      return "Registration has not been checked.";
    case "reading":
      return "Reading this client's configuration…";
    case "review":
      return "Ready to add Forge. Confirm below to register it.";
    case "authorizing":
      return "Recording your approval…";
    case "saving":
      return "Registering Forge…";
    case "checking":
      return "Checking the original registration receipt…";
    case "configured":
      return "Forge configuration confirmed. Client connection and trust have not been checked.";
    case "not-attempted":
      return "Registration was not attempted.";
    case "unknown":
      return "Registration is unconfirmed. Check its original receipt before another change.";
    case "blocked":
      return "Registration could not be reviewed.";
  }
}
function IntegrationCard({
  kind,
  connected,
}: {
  kind: IntegrationClient;
  connected: boolean;
}) {
  const [, changed] = useState(0),
    connection = useRef(connected);
  connection.current = connected;
  const [client] = useState(() => {
    let storage: Storage | null = null;
    try {
      storage = window.localStorage;
    } catch {
      /* Native recovery remains authoritative. */
    }
    const key = "agent-forge:mcp-registration:v1:" + kind;
    const invoke = (request: unknown) => {
      const bridge = nativeBridge();
      if (!bridge) return Promise.reject(Error("native-unavailable"));
      return bridge(request);
    };
    return createAppIntegrationsClient({
      client: kind,
      nativeAvailable: () => connection.current && nativeBridge() !== null,
      changed: () => changed((value) => value + 1),
      review: (client) => invoke({ operation: "review", client }),
      authorize: async (request) => {
        const response = await operatorPost(
          "/__agent-forge/app-settings/integrations/authorize",
          request,
          { maxBodyBytes: 2048 },
        );
        if (!response.ok) throw Error("authorization-unavailable");
        return response.json();
      },
      commit: (requestId) => invoke({ operation: "commit", requestId }),
      recover: (requestId) => invoke({ operation: "recover", requestId }),
      pending: {
        read() {
          const raw = storage?.getItem(key);
          if (!raw) return null;
          if (raw.length > 1024) throw Error("recovery-unavailable");
          try {
            return JSON.parse(raw);
          } catch {
            throw Error("recovery-unavailable");
          }
        },
        write(pending: IntegrationPending) {
          if (!storage) throw Error("recovery-unavailable");
          const raw = JSON.stringify(pending);
          storage.setItem(key, raw);
          if (storage.getItem(key) !== raw) throw Error("recovery-unavailable");
        },
        clear() {
          storage?.removeItem(key);
        },
      },
    });
  });
  useEffect(() => {
    client.setConnected(connected);
  }, [client, connected]);
  useEffect(() => () => client.dispose(), [client]);
  const view = client.state,
    label = labels[kind],
    busy = ["reading", "authorizing", "saving", "checking"].includes(
      view.phase,
    );
  const available = connected && nativeBridge() !== null;
  return (
    <section class="af-mcp-client" aria-labelledby={"mcp-" + kind + "-heading"}>
      <h4 id={"mcp-" + kind + "-heading"}>{label}</h4>
      <p role={view.error ? "alert" : "status"} aria-live="polite">
        {status(view)}
      </p>
      {view.error && <p>{reasons[view.error]}</p>}
      {!view.pending && (
        <button
          type="button"
          class="af-btn af-btn-secondary"
          disabled={!available || busy}
          onClick={() => {
            void client.review();
          }}
        >
          Review {label} registration
        </button>
      )}
      {view.review && (
        <div
          class="af-mcp-review"
          role="group"
          aria-label={"Confirm " + label + " registration"}
        >
          <p>
            Add the <code>agent-forge</code> stdio server to {label}'s user
            configuration for this checkout. Existing settings and other servers
            are preserved. Forge keeps a private original and receipt for
            recovery. No operator authority or client approval settings are
            granted.
          </p>
          <p>
            Review expires at{" "}
            <time dateTime={new Date(view.review.expiresAt).toISOString()}>
              {new Date(view.review.expiresAt).toLocaleTimeString()}
            </time>
            .
          </p>
          <div class="af-mcp-actions">
            <button
              type="button"
              class="af-btn af-btn-primary"
              disabled={!available || busy}
              onClick={() => {
                void client.confirm();
              }}
            >
              Register Forge in {label}
            </button>
            <button
              type="button"
              class="af-btn af-btn-secondary"
              disabled={busy}
              onClick={() => client.cancel()}
            >
              Cancel {label} review
            </button>
          </div>
        </div>
      )}
      {view.pending && (
        <div>
          <p>
            Original request: <code>{view.pending.requestId}</code>.
          </p>
          <button
            type="button"
            class="af-btn af-btn-secondary"
            disabled={!available || busy}
            onClick={() => {
              void client.recover();
            }}
          >
            Check {label} registration receipt
          </button>
        </div>
      )}
    </section>
  );
}
export function AppIntegrationsSettings({ connected }: { connected: boolean }) {
  const native = nativeBridge() !== null;
  return (
    <section
      class="af-app-hearth af-app-integrations"
      aria-labelledby="app-integrations-heading"
    >
      <h3 id="app-integrations-heading">MCP integrations</h3>
      <p>
        Register Forge tools in a client's user configuration. Choose Review,
        then confirm the registration. Finish any restart or trust step in that
        client.
      </p>
      {!native && (
        <p role="status">
          MCP registration is available in the Windows desktop app.
        </p>
      )}
      {!connected && (
        <p role="status">
          Reconnect to Hearth before reviewing or confirming registration.
        </p>
      )}
      <IntegrationCard kind="claude" connected={connected} />
      <IntegrationCard kind="codex" connected={connected} />
      <IntegrationCard kind="cursor" connected={connected} />
    </section>
  );
}
