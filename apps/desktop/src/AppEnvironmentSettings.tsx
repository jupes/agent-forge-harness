import { useEffect, useRef, useState } from "preact/hooks";
import { operatorPost, operatorRead } from "../../../docs/js/operator";
import { appStream, createRefetcher } from "../../../docs/js/use-stream";
import { ENVIRONMENT_LIMITS } from "../../../scripts/config/environment-protocol";
import {
  createEnvironmentSettingsClient,
  type EnvironmentSettingsClientState,
} from "./app-environment-client";
import "./app-hearth.css";
import "./app-environment.css";

export function EnvironmentSettingsView({
  state,
  connected,
  reviewable,
  saveable,
  validationError,
  check,
  edit,
  review,
  save,
  cancel,
}: {
  state: EnvironmentSettingsClientState;
  connected: boolean;
  reviewable: boolean;
  saveable: boolean;
  validationError: string | null;
  check(): void;
  edit(value: string): void;
  review(): void;
  save(): void;
  cancel(): void;
}) {
  const data = state.data,
    pending = state.pending,
    confirmed = state.confirmed;
  const editingDisabled =
    !connected ||
    !state.fresh ||
    state.busy ||
    !!pending ||
    state.storageProblem;
  return (
    <section
      class="af-app-hearth af-environment-settings"
      aria-labelledby="environment-settings-heading"
    >
      <h3 id="environment-settings-heading">Execution environment controls</h3>
      <p>
        Choose additional variable names that future config-reading executor
        launches may inherit. This changes neither the parent environment nor
        running agents. Provider adapters may apply their own environment
        policy.
      </p>
      <p>
        A name grants an allowance; it does not prove a value exists or was
        passed. Values are never read or entered here.
      </p>
      <button
        type="button"
        class="af-btn af-btn-secondary"
        disabled={state.busy || !connected}
        onClick={check}
      >
        Check environment settings
      </button>
      <p role={state.error ? "alert" : "status"} aria-live="polite">
        {state.busy
          ? "Working on environment settings…"
          : (state.error ??
            (data
              ? "Environment settings read."
              : "Environment settings have not been checked."))}
      </p>
      {!connected && (
        <p role="status">Reconnect to Hearth before reviewing a save.</p>
      )}
      {state.unsupported && (
        <p role="status">
          Environment controls are unsupported in this window. No empty
          allowance is inferred.
        </p>
      )}
      {state.storageProblem && (
        <p role="alert">
          This window cannot preserve or verify a pending request. Saving is
          held.
        </p>
      )}
      {pending && (
        <p role="alert">
          Unconfirmed save: <code>{pending.requestId}</code>. Check its exact
          receipt; no request will be replayed.
        </p>
      )}
      {confirmed && (
        <p role="status">
          Your save <code>{confirmed.requestId}</code> was confirmed at{" "}
          <time dateTime={confirmed.finishedAt}>{confirmed.finishedAt}</time>.
          That receipt describes the earlier publication; current configuration
          may differ.
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
          <dl>
            <dt>Current additional names</dt>
            <dd>
              {data.names.length
                ? data.names.map((name) => <code key={name}>{name} </code>)
                : "None (fixed base names still apply)."}
            </dd>
            <dt>Effective source</dt>
            <dd>
              <code>{data.provenance}</code>
            </dd>
            <dt>Save target</dt>
            <dd>
              {data.target === "workspace"
                ? "Connected workspace"
                : "Machine configuration"}
              : <code>{data.file}</code>
            </dd>
            <dt>Fixed base names</dt>
            <dd>
              {data.baseNames.map((name) => (
                <code key={name}>{name} </code>
              ))}
            </dd>
          </dl>
          <p>
            {data.target === "workspace"
              ? "A workspace configuration exists, so its security list replaces the machine list; machine names are never inherited."
              : "No workspace configuration exists. This saves the machine list without creating a workspace file. A future workspace file stops inheriting it."}
          </p>
          {!data.canSave && (
            <p role="status">
              Saving is held by private operation history or configuration that
              cannot be edited safely. Check status and inspect the
              configuration before recovery; history is never reset here.
            </p>
          )}
          {state.draftOwner !== data.ownerKey && (
            <p role="alert">
              The connected configuration changed. Cancel to load its current
              names, or explicitly edit a new draft before review.
            </p>
          )}
          <label for="environment-names">
            Additional variable names, one per line
          </label>
          <p id="environment-names-help">
            Letters, digits and underscores only; start with a letter or
            underscore. At most256 names, each at most128 characters. Names must
            be unique without regard to case. Do not enter values.
          </p>
          <textarea
            id="environment-names"
            rows={6}
            maxLength={ENVIRONMENT_LIMITS.requestBytes}
            aria-describedby="environment-names-help"
            aria-invalid={!!validationError}
            value={state.draft}
            disabled={editingDisabled}
            onInput={(event) => edit(event.currentTarget.value)}
            spellcheck={false}
            autoComplete="off"
          />
          {validationError && <p role="alert">{validationError}</p>}
          <div class="af-environment-actions">
            <button
              type="button"
              class="af-btn af-btn-secondary"
              disabled={!reviewable}
              onClick={review}
            >
              Review environment changes
            </button>
            <button
              type="button"
              class="af-btn af-btn-secondary"
              disabled={state.busy || !!pending}
              onClick={cancel}
            >
              Cancel environment changes
            </button>
          </div>
          {state.reviewed && (
            <div
              class="af-environment-review"
              role="group"
              aria-label="Review before saving"
            >
              <h4>Review before saving</h4>
              <p>
                Replace the additional-name list in <code>{data.file}</code>{" "}
                with:{" "}
                {state.reviewed.names.length
                  ? state.reviewed.names.map((name) => (
                      <code key={name}>{name} </code>
                    ))
                  : "None. Fixed base names remain."}
              </p>
              <p>
                This can allow sensitive values already present in a future
                executor's parent environment to reach that executor. Save only
                the names you intend to allow.
              </p>
              <button
                type="button"
                class="af-btn af-btn-primary"
                disabled={!saveable}
                onClick={save}
              >
                Save environment names
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}

export function AppEnvironmentSettings({ connected }: { connected: boolean }) {
  const [, changed] = useState(0),
    connection = useRef(connected);
  connection.current = connected;
  const [client] = useState(() => {
    let storage: Storage | null = null;
    try {
      storage = window.sessionStorage;
    } catch {
      /* Unavailable storage holds writes. */
    }
    return createEnvironmentSettingsClient({
      storage,
      requestId: () => crypto.randomUUID(),
      canAct: () => connection.current,
      changed: () => changed((value) => value + 1),
      read: () =>
        operatorRead(
          "/__agent-forge/app-settings/environment",
          {},
          { maxBodyBytes: ENVIRONMENT_LIMITS.responseBytes + 2048 },
        ),
      post: (request) =>
        operatorPost("/__agent-forge/app-settings/environment", request, {
          maxBodyBytes: ENVIRONMENT_LIMITS.responseBytes + 2048,
        }),
    });
  });
  useEffect(() => {
    if (connected) void client.check();
  }, [client, connected]);
  useEffect(() => {
    const refetch = createRefetcher({ run: () => client.check() }),
      stop = appStream().watch(["operator.action"], () => refetch.request());
    return () => {
      stop();
      refetch.dispose();
    };
  }, [client]);
  useEffect(() => () => client.dispose(), [client]);
  return (
    <EnvironmentSettingsView
      state={client.state}
      connected={connected}
      reviewable={client.canReview()}
      saveable={client.canSave()}
      validationError={client.validationError()}
      check={() => {
        void client.check();
      }}
      edit={(value) => client.edit(value)}
      review={() => client.review()}
      save={() => {
        void client.save();
      }}
      cancel={() => client.cancel()}
    />
  );
}
