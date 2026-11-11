import { useEffect, useRef, useState } from "preact/hooks";
import { operatorPost, operatorRead } from "../../../docs/js/operator";
import {
  createLedgerCompactionClient,
  type LedgerCompactionClientState,
} from "./ledger-compaction-client";
import "./app-hearth.css";

export function LedgerCompactionView({
  state,
  ready,
  connected,
  check,
  acknowledge,
  compact,
}: {
  state: LedgerCompactionClientState;
  ready: boolean;
  connected: boolean;
  check(): void;
  acknowledge(value: boolean): void;
  compact(): void;
}) {
  const last = state.data?.record.last;
  return (
    <section class="af-app-hearth" aria-labelledby="ledger-compaction-heading">
      <h3 id="ledger-compaction-heading">Ledger compaction</h3>
      <p>
        This affects the shared machine ledger across all workspaces. Events
        strictly older than 90 days lose their individual details; daily counts
        by workspace and event kind remain. Newer events are kept.
      </p>
      <p>
        A normal dated snapshot is taken first. It can replace the same UTC
        day’s snapshot and prune snapshots older than 14 days. It is not an
        immutable recovery copy or a verified restore. Other maintenance can run
        independently.
      </p>
      <button
        type="button"
        class="af-btn af-btn-secondary"
        disabled={state.busy || !connected}
        onClick={check}
      >
        Check compaction status
      </button>
      <p role={state.error ? "alert" : "status"} aria-live="polite">
        {state.busy
          ? "Checking or compacting the ledger…"
          : (state.error ??
            (state.data
              ? "Compaction status read."
              : "Compaction status has not been checked."))}
      </p>
      {!connected && (
        <p role="status">Reconnect to Hearth before reviewing compaction.</p>
      )}
      {state.storageProblem && (
        <p role="alert">
          The pending request cannot be preserved or verified in this window.
          Compaction is held.
        </p>
      )}
      {state.data && (
        <>
          <p>
            {!state.fresh || !connected
              ? "Showing last read values; they may be out of date. "
              : ""}
            Last read:{" "}
            <time dateTime={state.data.checkedAt}>{state.data.checkedAt}</time>.
          </p>
          {last ? (
            <>
              <p>
                Latest recorded operation: <code>{last.requestId}</code>.
                Started <time dateTime={last.startedAt}>{last.startedAt}</time>.
              </p>
              {last.state === "completed" ? (
                <p>
                  Confirmed: {last.events.toLocaleString()}{" "}
                  {last.events === 1 ? "event" : "events"} from{" "}
                  {last.days.toLocaleString()}{" "}
                  {last.days === 1 ? "day" : "days"} compacted before{" "}
                  <time dateTime={last.cutoffAt}>{last.cutoffAt}</time>.
                </p>
              ) : (
                <p role="alert">
                  Completion is unconfirmed. A snapshot or compaction may have
                  happened. Further compaction is held across restart; inspect
                  the ledger and backup before recovery.
                </p>
              )}
            </>
          ) : (
            <p>
              No Settings compaction has been recorded. This does not describe
              earlier CLI maintenance.
            </p>
          )}
          <p>
            Only the latest Settings receipt is retained. It does not confirm
            other maintenance or recover an earlier missing receipt.
          </p>
        </>
      )}
      {state.pending && (
        <p role="alert">
          Request <code>{state.pending.requestId}</code> remains to be checked.
          Only its exact completed receipt can resolve this window’s unknown
          outcome.
        </p>
      )}
      <label
        style={{
          display: "flex",
          alignItems: "center",
          minHeight: "32px",
          gap: "8px",
        }}
      >
        <input
          type="checkbox"
          checked={state.acknowledged}
          disabled={!ready || !connected}
          onChange={(event) => acknowledge(event.currentTarget.checked)}
        />
        I understand that compaction removes older event details from every
        workspace in this machine ledger.
      </label>
      <div class="af-actions">
        <button
          type="button"
          class="af-btn af-btn-danger"
          disabled={!ready || !connected || !state.acknowledged}
          onClick={compact}
        >
          Compact older events
        </button>
        <button
          type="button"
          class="af-btn af-btn-secondary"
          disabled={!state.acknowledged || state.busy}
          onClick={() => acknowledge(false)}
        >
          Cancel review
        </button>
      </div>
    </section>
  );
}
export function LedgerCompactionSettings({
  connected,
}: {
  connected: boolean;
}) {
  const [, changed] = useState(0),
    connection = useRef(connected);
  connection.current = connected;
  const [client] = useState(() => {
    let storage: Storage | null = null;
    try {
      storage = window.sessionStorage;
    } catch {
      /* Writes remain held without preserved intent. */
    }
    return createLedgerCompactionClient({
      storage,
      requestId: () => crypto.randomUUID(),
      canAct: () => connection.current,
      changed: () => changed((value) => value + 1),
      read: () =>
        operatorRead(
          "/__agent-forge/app-settings/ledger/compaction",
          {},
          { maxBodyBytes: 4096 },
        ),
      post: (request) =>
        operatorPost("/__agent-forge/app-settings/ledger/compact", request, {
          maxBodyBytes: 4096,
        }),
    });
  });
  useEffect(() => {
    client.acknowledge(false);
    if (connected) void client.check();
  }, [client, connected]);
  useEffect(() => () => client.dispose(), [client]);
  return (
    <LedgerCompactionView
      state={client.state}
      ready={client.canCompact()}
      connected={connected}
      check={() => {
        void client.check();
      }}
      acknowledge={(value) => client.acknowledge(value)}
      compact={() => {
        void client.compact();
      }}
    />
  );
}
