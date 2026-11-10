import { useEffect, useRef, useState } from "preact/hooks";
import { operatorRead } from "../../../docs/js/operator";
import {
  appStream,
  type LiveRead,
  pageReads,
  readOperatorRoute,
  startLiveRead,
} from "../../../docs/js/use-stream";
import {
  appHearthSettingsSchema,
  type AppHearthSettings as HearthSnapshot,
} from "../../../scripts/desktop/app-hearth-protocol";
import type { LedgerEventKind } from "../../../types/hearth";
import {
  acknowledgeDesktopRecovery,
  ConnectionBannerView,
  restartDesktopHearth,
  useDesktopRecovery,
} from "./ConnectionBanner";
import { LedgerBackupStatus } from "./LedgerBackupStatus";
import "./app-hearth.css";

const KINDS: readonly LedgerEventKind[] = [
  "operator.action",
  "session.started",
  "session.ended",
];
const UNAVAILABLE =
  "Hearth diagnostics could not be verified. Check the connection, then check diagnostics again.";
type Size = HearthSnapshot["ledger"]["database"];
function size(value: Size) {
  return value.state === "available"
    ? value.bytes.toLocaleString() + " bytes"
    : value.state === "missing"
      ? "Missing (not present at this read)"
      : "Unknown (file metadata unavailable)";
}
export function AppHearthSettings() {
  const recovery = useDesktopRecovery();
  const [state, setState] = useState<{
    data: HearthSnapshot | null;
    error: string | null;
    loading: boolean;
  }>({ data: null, error: null, loading: true });
  const live = useRef<LiveRead | null>(null);
  useEffect(() => {
    const read = startLiveRead<HearthSnapshot>({
      client: appStream(),
      kinds: KINDS,
      reportRefreshError: true,
      onChange: setState,
      async load() {
        setState((previous) => ({ ...previous, loading: true }));
        try {
          return appHearthSettingsSchema.parse(
            await readOperatorRoute<unknown>("/app-settings/hearth", {
              ...pageReads(),
              fetch: (path, init) =>
                operatorRead(path, init, { maxBodyBytes: 96 * 1024 }),
            }),
          );
        } catch {
          throw Error(UNAVAILABLE);
        }
      },
    });
    live.current = read;
    return () => {
      read();
      if (live.current === read) live.current = null;
    };
  }, []);
  const data = state.data;
  const stale =
    !!state.error ||
    state.loading ||
    recovery?.connection.phase !== "connected" ||
    recovery.busy;
  return (
    <section class="af-app-hearth" aria-labelledby="app-hearth-heading">
      <h3 id="app-hearth-heading">Hearth</h3>
      {recovery ? (
        <ConnectionBannerView
          state={recovery}
          restart={restartDesktopHearth}
          acknowledge={acknowledgeDesktopRecovery}
          allowConnectedRestart
        />
      ) : (
        <p role="status">Connection status unavailable.</p>
      )}
      <p role={state.error ? "alert" : "status"} aria-live="polite">
        {state.loading
          ? "Checking Hearth diagnostics…"
          : (state.error ?? "Hearth diagnostics read.")}
        {data && stale
          ? " Showing last read values; they may be out of date."
          : ""}
      </p>
      <button
        type="button"
        class="af-btn af-btn-secondary"
        disabled={state.loading}
        onClick={() => live.current?.reload()}
      >
        Check Hearth diagnostics
      </button>
      {data ? (
        <>
          <p>
            Last read:{" "}
            <time dateTime={data.checkedAt}>
              {new Date(data.checkedAt).toLocaleString()}
            </time>
            .
          </p>
          <dl>
            <dt>Hearth port</dt>
            <dd>{data.port ?? "Unknown (no listening port reported)"}</dd>
            <dt>API compatibility version</dt>
            <dd>{data.apiVersion}</dd>
            <dt>Ledger location</dt>
            <dd>
              <code>{data.ledger.path}</code>
            </dd>
            <dt>Database logical size</dt>
            <dd>{size(data.ledger.database)}</dd>
            <dt>Write-ahead log logical size</dt>
            <dd>{size(data.ledger.wal)}</dd>
            <dt>Shared-memory logical size</dt>
            <dd>{size(data.ledger.sharedMemory)}</dd>
          </dl>
          <p>
            Sizes are individual file lengths, not disk allocation or a
            transaction-consistent total. Missing files are not reported as
            zero.
          </p>
          <h4>Backup and compaction policy</h4>
          <LedgerBackupStatus
            schedule={data.upkeep.nightlyBackup}
            keepDays={data.upkeep.backupKeepDays}
          />
          <p>
            Manual compaction folds events older than{" "}
            {data.upkeep.retentionDays} days into daily summaries. This read
            does not run backup or compaction and does not confirm their latest
            success.
          </p>
          <h4>Execution environment</h4>
          {data.execution.state === "available" ? (
            <>
              <p>
                Additional configured names for executor inheritance
                (read-only):{" "}
                {data.execution.names.length
                  ? data.execution.names.map((name) => (
                      <code key={name}>{name} </code>
                    ))
                  : "None."}
              </p>
              <p>
                The executor also uses its built-in base environment. These are
                configured allowances; a name does not mean a value exists or
                was passed to a running agent. Provider adapters may supply
                their own environment.
              </p>
            </>
          ) : (
            <p role="status">
              Configured environment names unavailable. Check the machine
              configuration; no raw configuration or values are shown.
            </p>
          )}
        </>
      ) : !state.loading ? (
        <p>No verified diagnostics are available.</p>
      ) : null}
    </section>
  );
}
