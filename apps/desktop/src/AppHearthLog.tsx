import { useEffect, useRef, useState } from "preact/hooks";
import { operatorRead } from "../../../docs/js/operator";
import { appStream } from "../../../docs/js/use-stream";
import {
  HEARTH_LOG_LIMITS,
  HEARTH_LOG_MESSAGES,
  type HearthLogEntry,
} from "../../../scripts/desktop/app-hearth-log-protocol";
import { LEDGER_EVENT_KINDS } from "../../../types/hearth";
import {
  createHearthLogReadOwner,
  type HearthLogClientState,
} from "./app-hearth-log-client";
import "./app-hearth.css";

export function HearthLogView({
  state,
  rows,
  connected,
  check,
  filter,
}: {
  state: HearthLogClientState;
  rows: HearthLogEntry[];
  connected: boolean;
  check(): void;
  filter(value: string): void;
}) {
  const data = state.data;
  const stale = !!data && (!state.fresh || !connected || state.busy);
  return (
    <section
      class="af-app-hearth af-hearth-log"
      aria-labelledby="hearth-log-heading"
    >
      <h3 id="hearth-log-heading">Hearth service log</h3>
      <p>
        Fixed observations from this Hearth lifetime only. Ledger append
        evidence, including an audit row, does not confirm action completion.
        Other writers and raw console output are not included. Stop began does
        not confirm cleanup.
      </p>
      <button
        type="button"
        class="af-btn af-btn-secondary"
        disabled={state.busy || !connected}
        onClick={check}
      >
        Check Hearth service log
      </button>
      <p role={state.error ? "alert" : "status"} aria-live="polite">
        {state.busy
          ? "Checking Hearth service log…"
          : (state.error ??
            (data
              ? "Hearth service log read."
              : "Hearth service log has not been checked."))}
      </p>
      {!connected && (
        <p role="status">Reconnect to Hearth to check the service log.</p>
      )}
      {stale && (
        <p role="status">
          Showing the last read snapshot; it may be out of date.
        </p>
      )}
      {state.unsupported && (
        <p role="status">
          Hearth service logs are unsupported by this Hearth. No empty history
          is inferred.
        </p>
      )}
      {state.lifetimeChanged && data && (
        <p role="status">
          A new Hearth lifetime replaced the previous snapshot. Earlier
          observations are not combined with this lifetime.
        </p>
      )}
      {data && (
        <>
          <dl>
            <dt>Hearth lifetime</dt>
            <dd>
              <code>{data.generation}</code>
            </dd>
            <dt>Lifetime started</dt>
            <dd>
              <time dateTime={data.startedAt}>{data.startedAt}</time>
            </dd>
            <dt>Last read</dt>
            <dd>
              <time dateTime={data.checkedAt}>{data.checkedAt}</time>
            </dd>
            <dt>Latest observed sequence</dt>
            <dd>{data.latestSequence}</dd>
            <dt>Retained in this lifetime</dt>
            <dd>{data.retainedCount}</dd>
            <dt>Evicted before retained history</dt>
            <dd>{data.evictedCount}</dd>
            <dt>Retained observations omitted from this response</dt>
            <dd>{data.omittedRetainedCount}</dd>
          </dl>
          <label>
            Show observations
            <select
              value={state.filter}
              onChange={(event) => filter(event.currentTarget.value)}
            >
              <option value="all">All observations</option>
              <option value="warnings">Warnings only</option>
            </select>
          </label>
          <p>
            Showing {rows.length} of {data.entries.length} latest returned
            observations. The filter applies only to this response.
          </p>
          {data.entries.length === 0 ? (
            <p role="status">
              {stale
                ? "The last read snapshot returned no observations."
                : "No observations were returned for this Hearth lifetime."}
            </p>
          ) : rows.length === 0 ? (
            <p role="status">
              No warnings in the latest returned observations. Earlier
              observations may not be included.
            </p>
          ) : null}
          <div
            class="af-hearth-log-entries"
            role="region"
            aria-label="Hearth log entries"
            // biome-ignore lint/a11y/noNoninteractiveTabindex: Keyboard users need to focus this bounded scroll region.
            tabIndex={0}
          >
            <ol>
              {rows.map((entry) => (
                <li key={entry.sequence}>
                  <span>
                    #{entry.sequence} · {entry.level} ·{" "}
                  </span>
                  <time dateTime={entry.at}>{entry.at}</time>
                  <p>{HEARTH_LOG_MESSAGES[entry.code]}</p>
                  {entry.eventKind && (
                    <p>
                      Event kind: <code>{entry.eventKind}</code>
                    </p>
                  )}
                </li>
              ))}
            </ol>
          </div>
        </>
      )}
      {!data && !state.busy && (
        <p role="status">No verified service log snapshot is available.</p>
      )}
    </section>
  );
}

export function AppHearthLog({ connected }: { connected: boolean }) {
  const [, changed] = useState(0);
  const connection = useRef(connected);
  connection.current = connected;
  const [client] = useState(() =>
    createHearthLogReadOwner({
      canRead: () => connection.current,
      changed: () => changed((value) => value + 1),
      read: () =>
        operatorRead(
          "/__agent-forge/app-settings/hearth/logs",
          {},
          {
            maxBodyBytes: HEARTH_LOG_LIMITS.responseBytes + 2048,
          },
        ),
    }),
  );
  useEffect(() => {
    if (connected) client.request();
  }, [client, connected]);
  useEffect(() => {
    return appStream().watch(LEDGER_EVENT_KINDS, () => client.request());
  }, [client]);
  useEffect(() => () => client.dispose(), [client]);
  return (
    <HearthLogView
      state={client.state}
      rows={client.rows()}
      connected={connected}
      check={() => client.request()}
      filter={(value) => client.filter(value)}
    />
  );
}
