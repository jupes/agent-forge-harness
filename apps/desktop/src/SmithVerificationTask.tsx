import { useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import { Button } from "../../../docs/js/ds/Button";
import { Dialog } from "../../../docs/js/ds/Dialog";
import { APPRENTICE_VERIFICATION } from "../../../scripts/smith-verification";
import {
  createSmithVerificationClient,
  type SmithVerificationState,
} from "./smith-verification-client";
import { createSmithsReads } from "./smiths-read";

export function SmithVerificationBody({
  state,
  retry,
}: {
  state: SmithVerificationState;
  retry(): void;
}) {
  const data = state.data;
  return (
    <section
      class="af-smith-verification"
      aria-label="Verification task record"
      aria-busy={state.loading}
    >
      <p>
        Current record from the tracker served by this hearth. Task status does
        not certify live model or effort support.
      </p>
      <code>{APPRENTICE_VERIFICATION}</code>
      {state.loading ? (
        <p role="status">Reading the verification task…</p>
      ) : null}
      {state.error ? <p role="alert">{state.error}</p> : null}
      {data ? (
        <>
          {state.loading || state.error ? (
            <p>
              Earlier verified record; the current read has not been confirmed.
            </p>
          ) : null}
          <h3>{data.task.title}</h3>
          <dl class="af-smith-verification-facts">
            <dt>Recorded status</dt>
            <dd class="af-smith-verification-value">{data.task.status}</dd>
            <dt>Recorded priority</dt>
            <dd class="af-smith-verification-value">
              {data.task.priority === null
                ? "Not reported"
                : `P${data.task.priority}`}
            </dd>
            <dt>Served workspace</dt>
            <dd class="af-smith-verification-value">
              <code>{data.workspace}</code>
            </dd>
            <dt>Checked</dt>
            <dd class="af-smith-verification-value">
              <time dateTime={data.checkedAt}>{data.checkedAt}</time>
            </dd>
            <dt>Task updated</dt>
            <dd class="af-smith-verification-value">
              {data.task.updatedAt ?? "Not reported"}
            </dd>
          </dl>
          {(
            [
              ["Description", data.task.description],
              ["Acceptance criteria", data.task.acceptanceCriteria],
              ["Notes", data.task.notes],
            ] as const
          ).map(([label, text]) => (
            <div key={label}>
              <h4>{label}</h4>
              <p class="af-smith-verification-text">{text || "Not recorded"}</p>
            </div>
          ))}
        </>
      ) : null}
      <Button disabled={state.loading} onClick={retry}>
        {state.error ? "Retry verification read" : "Refresh verification task"}
      </Button>
    </section>
  );
}

/** Mounted per served workspace; the observer starts only when the operator opens it. */
export function SmithVerificationTask({
  workspace,
}: {
  workspace: string | null;
}) {
  const opener = useRef<HTMLButtonElement>(null);
  const client = useMemo(
    () =>
      workspace
        ? createSmithVerificationClient({
            workspace,
            read: createSmithsReads().verification,
          })
        : null,
    [workspace],
  );
  const [snapshot, paint] = useState<{
    client: typeof client;
    state: SmithVerificationState;
  } | null>(null);
  const state =
    snapshot?.client === client
      ? snapshot.state
      : (client?.get() ?? {
          open: false,
          loading: false,
          data: null,
          error: "",
        });
  useLayoutEffect(() => {
    if (!client) return;
    const changed = () => paint({ client, state: client.get() });
    const unsubscribe = client.subscribe(changed);
    changed();
    return () => {
      unsubscribe();
      client.dispose();
    };
  }, [client]);
  return (
    <>
      <button
        ref={opener}
        class="af-btn af-btn-secondary"
        type="button"
        disabled={!client}
        onClick={() => {
          void client?.open();
        }}
      >
        Open verification task
      </button>
      <Dialog
        open={state.open}
        title="Apprentice verification task"
        titleId="af-smith-verification-title"
        onClose={() => client?.close()}
        returnFocusRef={opener}
        actions={
          <Button onClick={() => client?.close()}>
            Close verification task
          </Button>
        }
      >
        <SmithVerificationBody
          state={state}
          retry={() => {
            void client?.refresh();
          }}
        />
      </Dialog>
    </>
  );
}
