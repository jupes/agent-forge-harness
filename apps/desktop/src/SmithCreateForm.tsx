import type { JSX } from "preact";
import type { SmithConfigPreviewRequest } from "../../../types/smith-config-create";
import type {
  SmithCreateClientState,
  SmithCreateEntry,
} from "./smith-create-client";

export function SmithCreateFormView({
  state,
  draftReady,
  canWrite,
  canStart,
  onDraft,
  onPreview,
  onCreate,
}: {
  state: SmithCreateClientState;
  /** The current draft has a verified trusted workspace scope. */
  draftReady: boolean;
  canWrite: boolean;
  canStart: boolean;
  onDraft(
    target: SmithCreateClientState["target"],
    smith: SmithCreateClientState["smith"],
  ): void;
  onPreview(): void;
  onCreate(): void;
}): JSX.Element {
  const smith = state.smith,
    reserved = state.entries.some(
      (item) => item.serverIdentity?.stage === "reserved",
    ),
    held = state.entries.some(
      (item) =>
        item.state === "held" && item.serverIdentity?.stage !== "reserved",
    ),
    blocked = !canWrite || !canStart || held || state.creating,
    draftBlocked = !draftReady || state.creating,
    update = (patch: Partial<SmithConfigPreviewRequest["smith"]>) => {
      if (draftBlocked) return;
      onDraft(state.target, { ...smith, ...patch });
    };
  return (
    <div class="af-smith-create">
      <p>
        Review a complete Smith against the current paired configuration. Any
        edit clears the candidate. Create first reserves this exact original;
        configuration changes only after a reviewed create attempt succeeds.
      </p>
      {!draftReady && (
        <p role="status">Waiting for a verified workspace before editing.</p>
      )}
      {!canWrite && (
        <p role="status">
          The hearth is not ready for operator writes. Your draft is not sent.
        </p>
      )}
      {canWrite && !state.serverDiscoveryReady && (
        <p role="status">Checking the complete server-owned create history…</p>
      )}
      {canWrite &&
        !canStart &&
        !held &&
        !reserved &&
        state.serverDiscoveryReady && (
          <p role="alert">
            Saved create identities could not be verified. Their data was kept;
            no new request can start.
          </p>
        )}
      {held && (
        <p role="alert">
          An earlier create has an unknown outcome. Check its original receipt
          below before starting another request.
        </p>
      )}
      {reserved && (
        <p role="alert">
          An exact original is reserved by the server and has not started.
          Review its saved details below, then explicitly continue it or retire
          the reservation before creating another Smith.
        </p>
      )}
      <label>
        Save to
        <select
          value={state.target}
          disabled={draftBlocked}
          onChange={(event) => {
            if (draftBlocked) return;
            onDraft(
              event.currentTarget.value === "user" ? "user" : "workspace",
              smith,
            );
          }}
        >
          <option value="workspace">Workspace configuration</option>
          <option value="user">User configuration</option>
        </select>
      </label>
      <label>
        Smith name
        <input
          value={smith.name}
          maxLength={128}
          disabled={draftBlocked}
          onInput={(event) => update({ name: event.currentTarget.value })}
        />
      </label>
      <label>
        Provider
        <input
          value={smith.provider}
          maxLength={128}
          disabled={draftBlocked}
          onInput={(event) => update({ provider: event.currentTarget.value })}
        />
      </label>
      <label>
        Model
        <input
          value={smith.model}
          maxLength={512}
          disabled={draftBlocked}
          onInput={(event) => update({ model: event.currentTarget.value })}
        />
      </label>
      <label>
        Effort
        <input
          value={smith.effort}
          maxLength={128}
          disabled={draftBlocked}
          onInput={(event) => update({ effort: event.currentTarget.value })}
        />
      </label>
      <label class="af-smith-create-enabled">
        <input
          type="checkbox"
          checked={smith.enabled}
          disabled={draftBlocked}
          onChange={(event) => update({ enabled: event.currentTarget.checked })}
        />
        Enabled
      </label>
      <label>
        Tags
        <textarea
          value={smith.tags.join("\n")}
          maxLength={16_448}
          rows={3}
          disabled={draftBlocked}
          onInput={(event) =>
            update({
              tags: event.currentTarget.value
                .split(/\r?\n/)
                .filter((tag) => tag.length > 0),
            })
          }
        />
        <small>One exact tag per line; up to 64 tags.</small>
      </label>
      {state.notice && <p role="status">{state.notice}</p>}
      <div class="af-smith-create-actions">
        <button
          type="button"
          disabled={blocked || state.previewing}
          onClick={onPreview}
        >
          {state.previewing ? "Reviewing candidate…" : "Review candidate"}
        </button>
        <button
          type="button"
          disabled={
            blocked || state.previewing || !state.preview || !sameReview(state)
          }
          onClick={onCreate}
        >
          {state.creating ? "Saving original…" : "Create Smith"}
        </button>
      </div>
      {state.preview && (
        <section aria-label="Candidate review" class="af-smith-create-review">
          <h3>Candidate review</h3>
          <dl>
            <dt>Target layer</dt>
            <dd>{state.preview.target}</dd>
            <dt>Configuration file</dt>
            <dd>
              <code>{state.preview.file}</code>
            </dd>
            <dt>Candidate change</dt>
            <dd>
              {state.preview.candidate.created
                ? "Will create a new target file"
                : "Will add this Smith to the existing target file"}
            </dd>
            <dt>Candidate SHA-256</dt>
            <dd>
              <code>{state.preview.candidate.sha256}</code>
            </dd>
            <dt>Candidate bytes</dt>
            <dd>{state.preview.candidate.byteLength}</dd>
            <dt>Paired user revision</dt>
            <dd>
              <code>{state.preview.expectedRevision.user}</code>
            </dd>
            <dt>Paired workspace revision</dt>
            <dd>
              <code>{state.preview.expectedRevision.workspace}</code>
            </dd>
            <dt>New Smith</dt>
            <dd>
              <code>{state.preview.review.after.name}</code> · provider{" "}
              <code>{state.preview.review.after.provider}</code> · model{" "}
              <code>{state.preview.review.after.model}</code> · effort{" "}
              <code>{state.preview.review.after.effort}</code> ·{" "}
              {state.preview.review.after.enabled ? "enabled" : "disabled"} ·
              tags {state.preview.review.after.tags.join(", ") || "none"}
            </dd>
            {Object.entries(state.preview.review.provenance).map(
              ([field, source]) => (
                <div key={field}>
                  <dt>{field} source</dt>
                  <dd>
                    <code>{source}</code>
                  </dd>
                </div>
              ),
            )}
          </dl>
        </section>
      )}
    </div>
  );
}

function sameReview(state: SmithCreateClientState): boolean {
  const preview = state.preview;
  return Boolean(
    preview &&
      preview.target === state.target &&
      JSON.stringify(preview.review.after) === JSON.stringify(state.smith),
  );
}

export function SmithCreateReceiptsView({
  entries,
  canWrite,
  creating,
  onCheck,
  onContinue,
  onRetire,
}: {
  entries: readonly SmithCreateEntry[];
  canWrite: boolean;
  creating: boolean;
  onCheck(requestId: string): void;
  onContinue(requestId: string): void;
  onRetire(requestId: string): void;
}): JSX.Element | null {
  if (entries.length === 0) return null;
  return (
    <section
      aria-label="Original Smith create receipts"
      class="af-smith-panel af-smith-create-receipts"
    >
      <h2>Original Smith create receipts</h2>
      <p>
        Saved request identities are never sent again automatically. An
        uncertain request can only be checked against its same protected
        original receipt.
      </p>
      {entries.map((entry) => (
        <article key={entry.identity.requestId}>
          <h3>
            {entry.serverIdentity?.stage === "reserved"
              ? "Reserved original — not started"
              : entry.state === "confirmed"
                ? "Confirmed"
                : entry.state === "refused"
                  ? "Refused before publication"
                  : entry.state === "not-sent"
                    ? "Not sent"
                    : "Outcome held"}
          </h3>
          <dl>
            <dt>Request UUID</dt>
            <dd>
              <code>{entry.identity.requestId}</code>
            </dd>
            <dt>Target</dt>
            <dd>{entry.identity.target}</dd>
            <dt>Original input SHA-256</dt>
            <dd>
              <code>{entry.identity.inputHash}</code>
            </dd>
            {entry.receipt && (
              <>
                <dt>Original Smith</dt>
                <dd>
                  {entry.receipt.original.smith.name} ·{" "}
                  {entry.receipt.original.smith.provider} ·{" "}
                  {entry.receipt.original.smith.model} ·{" "}
                  {entry.receipt.original.smith.effort} ·{" "}
                  {entry.receipt.original.smith.enabled
                    ? "enabled"
                    : "disabled"}{" "}
                  · tags{" "}
                  {entry.receipt.original.smith.tags.join(", ") || "none"}
                </dd>
                <dt>Original target</dt>
                <dd>{entry.receipt.original.target}</dd>
                <dt>Original user revision</dt>
                <dd>
                  <code>{entry.receipt.original.expectedRevision.user}</code>
                </dd>
                <dt>Original workspace revision</dt>
                <dd>
                  <code>
                    {entry.receipt.original.expectedRevision.workspace}
                  </code>
                </dd>
                {entry.receipt.result.preview && (
                  <>
                    <dt>Prepared target file</dt>
                    <dd>
                      <code>{entry.receipt.result.preview.file}</code>
                    </dd>
                    <dt>Prepared candidate SHA-256</dt>
                    <dd>
                      <code>
                        {entry.receipt.result.preview.candidate.sha256}
                      </code>
                    </dd>
                    <dt>Prepared candidate bytes</dt>
                    <dd>{entry.receipt.result.preview.candidate.byteLength}</dd>
                  </>
                )}
              </>
            )}
            {entry.receipt?.result.phase === "confirmed" && (
              <>
                <dt>Confirmed file</dt>
                <dd>
                  <code>{entry.receipt.result.publication.file}</code>
                </dd>
                <dt>Published SHA-256</dt>
                <dd>
                  <code>{entry.receipt.result.publication.sha256}</code>
                </dd>
              </>
            )}
            {entry.receipt?.result.phase === "refused" && (
              <>
                <dt>Reason</dt>
                <dd>{entry.receipt.result.reason}</dd>
              </>
            )}
          </dl>
          <p role={entry.state === "held" ? "alert" : "status"}>
            {entry.notice}
          </p>
          {entry.state === "held" && (
            <>
              <button
                type="button"
                disabled={entry.checking || creating}
                onClick={() => onCheck(entry.identity.requestId)}
              >
                {entry.checking
                  ? "Checking original…"
                  : "Check original receipt"}
              </button>
              {entry.continueAllowed &&
                entry.serverIdentity?.stage === "reserved" &&
                entry.receipt?.result.phase === "held" &&
                entry.receipt.result.stage === "reserved" && (
                  <>
                    <button
                      type="button"
                      disabled={!canWrite || entry.checking || creating}
                      onClick={() => onContinue(entry.identity.requestId)}
                    >
                      Continue this exact saved original
                    </button>
                    <button
                      type="button"
                      disabled={!canWrite || entry.checking || creating}
                      onClick={() => onRetire(entry.identity.requestId)}
                    >
                      Retire this reservation
                    </button>
                  </>
                )}
            </>
          )}
        </article>
      ))}
    </section>
  );
}
