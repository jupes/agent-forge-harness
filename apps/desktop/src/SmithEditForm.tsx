import type { JSX } from "preact";
import type { Smith } from "../../../types/hearth";
import type {
  SmithConfigEditTarget,
  SmithConfigEditTargetBefore,
} from "../../../types/smith-config-edit";
import type { SmithEditClientState, SmithEditEntry } from "./smith-edit-client";

const FIELDS = ["provider", "model", "effort", "enabled", "tags"] as const;
type Field = (typeof FIELDS)[number];

function fieldValue(value: unknown): string {
  if (Array.isArray(value)) return value.join(", ") || "No tags";
  if (typeof value === "boolean") return value ? "Enabled" : "Disabled";
  return value === undefined
    ? "Not present in this target layer"
    : String(value);
}

function FieldList({
  value,
  label,
}: {
  value: Smith | SmithConfigEditTargetBefore | null;
  label: string;
}): JSX.Element {
  return (
    <div class="af-smith-edit-field-list">
      <h4>{label}</h4>
      {value === null ? (
        <p>
          No Smith entry exists in this target layer; saving will materialize
          this complete entry.
        </p>
      ) : (
        <dl>
          {FIELDS.map((field) => (
            <div key={field}>
              <dt>{field}</dt>
              <dd>{fieldValue(value[field])}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}

function Provenance({
  before,
  after,
}: {
  before: Record<Field, string>;
  after: Record<Field, string>;
}): JSX.Element {
  return (
    <div class="af-smith-edit-provenance">
      <h4>Field provenance before and after</h4>
      <dl>
        {FIELDS.map((field) => (
          <div key={field}>
            <dt>{field}</dt>
            <dd>
              <span>
                Before: <code>{before[field]}</code>
              </span>
              <span>
                After: <code>{after[field]}</code>
              </span>
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

export function SmithEditFormView({
  state,
  canWrite,
  canStart,
  onDraft,
  onPreview,
  onSave,
}: {
  state: SmithEditClientState;
  canWrite: boolean;
  canStart: boolean;
  onDraft(target: SmithConfigEditTarget, name: string, smith: Smith): void;
  onPreview(): void;
  onSave(): void;
}): JSX.Element {
  const smith = state.smith;
  const update = (patch: Partial<Smith>) =>
    onDraft(state.target, state.name, { ...smith, ...patch, name: state.name });
  const held = state.entries.some((entry) => entry.state === "held");
  const sameReview = Boolean(
    state.preview &&
      state.preview.target === state.target &&
      state.preview.review.name === state.name &&
      JSON.stringify(state.preview.review.effectiveAfter) ===
        JSON.stringify(smith) &&
      JSON.stringify(state.preview.review.targetAfter) ===
        JSON.stringify(smith),
  );
  const blocked =
    !canWrite || !canStart || held || state.saving || state.previewing;
  return (
    <div class="af-smith-edit">
      <p>
        Edit the selected existing Smith by name. The selected name stays fixed;
        review the complete layered change before saving.
      </p>
      {!canWrite && (
        <p role="status">
          Operator writes are unavailable. No edit request will be sent.
        </p>
      )}
      {canWrite && !canStart && !held && (
        <p role="alert">
          Saved Smith edit metadata could not be verified. Its bytes were kept;
          no new edit can start.
        </p>
      )}
      {held && (
        <p role="alert">
          An earlier Smith edit is unresolved. Check only its protected original
          receipt before starting another edit.
        </p>
      )}
      <label>
        Selected Smith name
        <input value={state.name} readOnly aria-readonly="true" />
      </label>
      <label>
        Save to
        <select
          value={state.target}
          disabled={state.saving}
          onChange={(event) =>
            onDraft(
              event.currentTarget.value === "user" ? "user" : "workspace",
              state.name,
              smith,
            )
          }
        >
          <option value="workspace">Workspace configuration</option>
          <option value="user">User configuration</option>
        </select>
      </label>
      <label>
        Provider
        <input
          value={smith.provider}
          maxLength={128}
          disabled={state.saving}
          onInput={(event) => update({ provider: event.currentTarget.value })}
        />
      </label>
      <label>
        Model
        <input
          value={smith.model}
          maxLength={512}
          disabled={state.saving}
          onInput={(event) => update({ model: event.currentTarget.value })}
        />
      </label>
      <label>
        Effort
        <input
          value={smith.effort}
          maxLength={128}
          disabled={state.saving}
          onInput={(event) => update({ effort: event.currentTarget.value })}
        />
      </label>
      <label class="af-smith-edit-enabled">
        <input
          type="checkbox"
          checked={smith.enabled}
          disabled={state.saving}
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
          disabled={state.saving}
          onInput={(event) =>
            update({
              tags: event.currentTarget.value
                .split(/\r?\n/)
                .filter((tag) => tag.length > 0),
            })
          }
        />
        <small>
          One exact tag per line. Rank is already part of the saved tags.
        </small>
      </label>
      {state.notice && <p role="status">{state.notice}</p>}
      <div class="af-smith-edit-actions">
        <button type="button" disabled={blocked} onClick={onPreview}>
          {state.previewing ? "Reviewing candidate…" : "Review candidate"}
        </button>
        <button
          type="button"
          disabled={blocked || !sameReview}
          onClick={onSave}
        >
          {state.saving ? "Saving original…" : "Save reviewed edit"}
        </button>
      </div>
      {state.preview && (
        <section aria-label="Smith edit review" class="af-smith-edit-review">
          <h3>Review this Smith edit</h3>
          <dl>
            <dt>Immutable Smith name</dt>
            <dd>
              <code>{state.preview.review.name}</code>
            </dd>
            <dt>Target layer</dt>
            <dd>{state.preview.target}</dd>
            <dt>Configuration file</dt>
            <dd>
              <code>{state.preview.file}</code>
            </dd>
            <dt>Candidate SHA-256</dt>
            <dd>
              <code>{state.preview.candidate.sha256}</code>
            </dd>
            <dt>Paired user revision</dt>
            <dd>
              <code>{state.preview.expectedRevision.user}</code>
            </dd>
            <dt>Paired workspace revision</dt>
            <dd>
              <code>{state.preview.expectedRevision.workspace}</code>
            </dd>
          </dl>
          <div class="af-smith-edit-review-columns">
            <FieldList
              value={state.preview.review.targetBefore}
              label="Target-layer before"
            />
            <FieldList
              value={state.preview.review.targetAfter}
              label="Target-layer after"
            />
            <FieldList
              value={state.preview.review.effectiveBefore}
              label="Effective configuration before"
            />
            <FieldList
              value={state.preview.review.effectiveAfter}
              label="Effective configuration after"
            />
          </div>
          <Provenance
            before={state.preview.review.provenanceBefore}
            after={state.preview.review.provenanceAfter}
          />
        </section>
      )}
    </div>
  );
}

export function SmithEditReceiptsView({
  entries,
  canWrite,
  onCheck,
}: {
  entries: readonly SmithEditEntry[];
  canWrite: boolean;
  onCheck(requestId: string): void;
}): JSX.Element | null {
  if (entries.length === 0) return null;
  return (
    <section
      aria-label="Original Smith edit receipts"
      class="af-smith-panel af-smith-edit-receipts"
    >
      <h2>Original Smith edit receipts</h2>
      <p>
        Saved edit identities are never sent again automatically. An uncertain
        edit can only be checked against its same protected original.
      </p>
      {entries.map((entry) => (
        <article key={entry.identity.requestId}>
          <h3>
            {entry.state === "confirmed"
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
            <dt>Smith name</dt>
            <dd>
              <code>{entry.identity.name}</code>
            </dd>
            <dt>Target</dt>
            <dd>{entry.identity.target}</dd>
            <dt>Original input SHA-256</dt>
            <dd>
              <code>{entry.identity.inputHash}</code>
            </dd>
            {entry.receipt && (
              <>
                <dt>Original provider and model</dt>
                <dd>
                  {entry.receipt.original.smith.provider} ·{" "}
                  <code>{entry.receipt.original.smith.model}</code>
                </dd>
                <dt>Original effort, status, and tags</dt>
                <dd>
                  {entry.receipt.original.smith.effort} ·{" "}
                  {entry.receipt.original.smith.enabled
                    ? "enabled"
                    : "disabled"}{" "}
                  · {entry.receipt.original.smith.tags.join(", ") || "No tags"}
                </dd>
                {entry.receipt.result.preview && (
                  <>
                    <dt>Target file</dt>
                    <dd>
                      <code>{entry.receipt.result.preview.file}</code>
                    </dd>
                    <dt>Candidate SHA-256</dt>
                    <dd>
                      <code>
                        {entry.receipt.result.preview.candidate.sha256}
                      </code>
                    </dd>
                  </>
                )}
                {entry.receipt.result.phase === "refused" && (
                  <>
                    <dt>Refusal</dt>
                    <dd>{entry.receipt.result.reason}</dd>
                  </>
                )}
                {entry.receipt.result.phase === "held" && (
                  <>
                    <dt>Saved stage</dt>
                    <dd>{entry.receipt.result.stage}</dd>
                  </>
                )}
              </>
            )}
          </dl>
          <p role={entry.state === "held" ? "alert" : "status"}>
            {entry.notice}
          </p>
          {entry.state === "held" && (
            <button
              type="button"
              disabled={!canWrite || entry.checking}
              onClick={() => onCheck(entry.identity.requestId)}
            >
              {entry.checking ? "Checking original…" : "Check original receipt"}
            </button>
          )}
        </article>
      ))}
    </section>
  );
}
