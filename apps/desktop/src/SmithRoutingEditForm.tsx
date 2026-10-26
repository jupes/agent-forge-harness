import type { JSX } from "preact";
import { useState } from "preact/hooks";
import { smithRoutingEditPreviewRequestSchema } from "../../../scripts/config/smith-routing-edit-protocol";
import type {
  SmithRoutingEditChange,
  SmithRoutingEditPreview,
  SmithRoutingEditTarget,
} from "../../../types/smith-routing-edit";
import type {
  SmithRoutingEditClientState,
  SmithRoutingEditEntry,
} from "./smith-routing-edit-client";

const routeSelector = (change: SmithRoutingEditChange) =>
  change.kind === "default"
    ? "workflow.default_crew"
    : `benches.${change.bench}`;
const showValue = (value: unknown) =>
  value === null ? "Not present in this target" : JSON.stringify(value);

function Review({
  preview,
}: {
  preview: SmithRoutingEditPreview;
}): JSX.Element {
  return (
    <section class="af-smith-routing-review" aria-label="Routing edit review">
      <h3>Review this complete routing edit</h3>
      <dl>
        <dt>Selected routing value</dt>
        <dd>
          <code>{routeSelector(preview.review.change)}</code>
        </dd>
        <dt>Write target</dt>
        <dd>
          {preview.target === "workspace"
            ? "Workspace configuration"
            : "User configuration"}
        </dd>
        <dt>Target file</dt>
        <dd>
          <code>{preview.file}</code>
        </dd>
        <dt>Target value before</dt>
        <dd>
          <code>{showValue(preview.review.targetBefore)}</code>
        </dd>
        <dt>Target value after</dt>
        <dd>
          <code>{showValue(preview.review.targetAfter)}</code>
        </dd>
        <dt>Effective value before</dt>
        <dd>
          <code>{showValue(preview.review.effectiveBefore)}</code>
        </dd>
        <dt>Effective value after</dt>
        <dd>
          <code>{showValue(preview.review.effectiveAfter)}</code>
        </dd>
        <dt>Provenance before</dt>
        <dd>
          <code>{preview.review.provenanceBefore}</code>
        </dd>
        <dt>Provenance after</dt>
        <dd>
          <code>{preview.review.provenanceAfter}</code>
        </dd>
        <dt>Paired user revision</dt>
        <dd>
          <code>{preview.expectedRevision.user}</code>
        </dd>
        <dt>Paired workspace revision</dt>
        <dd>
          <code>{preview.expectedRevision.workspace}</code>
        </dd>
        <dt>Candidate SHA-256</dt>
        <dd>
          <code>{preview.candidate.sha256}</code>
        </dd>
      </dl>
    </section>
  );
}

export function SmithRoutingEditFormView({
  seed,
  state,
  canWrite,
  onDraft,
  onPreview,
  onSave,
}: {
  seed: SmithRoutingEditChange;
  state: SmithRoutingEditClientState;
  canWrite: boolean;
  onDraft(target: SmithRoutingEditTarget, change: SmithRoutingEditChange): void;
  onPreview(): void;
  onSave(): void;
}): JSX.Element {
  const [target, setTarget] = useState<SmithRoutingEditTarget | null>(null);
  const [change, setChange] = useState<SmithRoutingEditChange>(seed);
  const [weightText, setWeightText] = useState(
    seed.kind === "bench"
      ? seed.entries.map((entry) => String(entry.weight))
      : [],
  );
  const held = state.entries.some((entry) => entry.state === "held");
  const valid =
    target !== null &&
    smithRoutingEditPreviewRequestSchema.safeParse({ target, change }).success;
  const sameReview = Boolean(
    valid &&
      state.preview &&
      !state.previewStale &&
      state.preview.target === target &&
      JSON.stringify(state.preview.review.change) === JSON.stringify(change),
  );
  const update = (next: SmithRoutingEditChange) => {
    setChange(next);
    if (target) onDraft(target, next);
  };
  const updateTarget = (next: SmithRoutingEditTarget) => {
    setTarget(next);
    onDraft(next, change);
  };
  const changeRow = (
    index: number,
    field: "smith" | "weight",
    value: string,
  ) => {
    if (change.kind !== "bench") return;
    const entries = change.entries.map((entry, row) =>
      row === index
        ? { ...entry, [field]: field === "weight" ? Number(value) : value }
        : entry,
    );
    if (field === "weight")
      setWeightText(
        weightText.map((text, row) => (row === index ? value : text)),
      );
    update({ ...change, entries });
  };
  const moveRow = (index: number, direction: -1 | 1) => {
    if (change.kind !== "bench") return;
    const to = index + direction;
    if (to < 0 || to >= change.entries.length) return;
    const entries = [...change.entries];
    [entries[index], entries[to]] = [entries[to]!, entries[index]!];
    const texts = [...weightText];
    [texts[index], texts[to]] = [texts[to]!, texts[index]!];
    setWeightText(texts);
    update({ ...change, entries });
  };
  const blocked =
    !canWrite || !valid || held || state.saving || state.previewing;
  return (
    <div class="af-smith-routing-edit">
      <p>
        Choose the target layer yourself. Review the complete saved and
        effective routing values before saving.
      </p>
      {!canWrite && (
        <p role="status">
          Operator writes are unavailable. No routing edit will be sent.
        </p>
      )}
      {held && (
        <p role="alert">
          An earlier routing edit is unresolved. Check only its protected
          original receipt before starting another edit.
        </p>
      )}
      <fieldset class="af-smith-routing-target">
        <legend>Save to an explicit target</legend>
        <label>
          <input
            type="radio"
            name="smith-routing-target"
            checked={target === "workspace"}
            onChange={() => updateTarget("workspace")}
          />
          Workspace configuration
        </label>
        <label>
          <input
            type="radio"
            name="smith-routing-target"
            checked={target === "user"}
            onChange={() => updateTarget("user")}
          />
          User configuration
        </label>
      </fieldset>
      {change.kind === "default" ? (
        <label class="af-smith-routing-field">
          Default Smith name
          <input
            aria-label="Default Smith name"
            maxLength={256}
            value={change.smith}
            onInput={(event) =>
              update({ ...change, smith: event.currentTarget.value })
            }
          />
          <small>
            Type a Smith name; the server verifies it is configured before
            preparing a write.
          </small>
        </label>
      ) : (
        <section
          aria-label={`${change.bench} bench rows`}
          class="af-smith-routing-rows"
        >
          <h3>{change.bench} bench rows in saved order</h3>
          {change.entries.map((entry, index) => (
            <fieldset class="af-smith-routing-row" key={index}>
              <legend>Entry {index + 1}</legend>
              <label>
                Smith name
                <input
                  aria-label={`Smith name ${index + 1}`}
                  maxLength={256}
                  value={entry.smith}
                  onInput={(event) =>
                    changeRow(index, "smith", event.currentTarget.value)
                  }
                />
              </label>
              <label>
                Weight
                <input
                  aria-label={`Weight ${index + 1}`}
                  inputMode="decimal"
                  value={weightText[index] ?? String(entry.weight)}
                  onInput={(event) =>
                    changeRow(index, "weight", event.currentTarget.value)
                  }
                />
              </label>
              <div class="af-smith-routing-row-actions">
                <button
                  type="button"
                  aria-label={`Move entry ${index + 1} up`}
                  disabled={index === 0 || state.saving}
                  onClick={() => moveRow(index, -1)}
                >
                  Move up
                </button>
                <button
                  type="button"
                  aria-label={`Move entry ${index + 1} down`}
                  disabled={index === change.entries.length - 1 || state.saving}
                  onClick={() => moveRow(index, 1)}
                >
                  Move down
                </button>
                <button
                  type="button"
                  aria-label={`Remove entry ${index + 1}`}
                  disabled={change.entries.length <= 1 || state.saving}
                  onClick={() => {
                    setWeightText(weightText.filter((_, row) => row !== index));
                    update({
                      ...change,
                      entries: change.entries.filter((_, row) => row !== index),
                    });
                  }}
                >
                  Remove
                </button>
              </div>
            </fieldset>
          ))}
          <button
            type="button"
            disabled={state.saving || change.entries.length >= 600}
            onClick={() => {
              setWeightText([...weightText, "1"]);
              update({
                ...change,
                entries: [...change.entries, { smith: "", weight: 1 }],
              });
            }}
          >
            Add bench row
          </button>
          <small>
            Rows remain ordered and duplicate names are kept. Each name must be
            configured; weights may be positive finite fractions.
          </small>
        </section>
      )}
      {state.notice && <p role="status">{state.notice}</p>}
      <div class="af-smith-routing-actions">
        <button
          type="button"
          disabled={blocked}
          onClick={() => {
            if (target && valid) {
              onDraft(target, change);
              onPreview();
            }
          }}
        >
          {state.previewing ? "Reviewing candidate…" : "Review routing edit"}
        </button>
        <button
          type="button"
          disabled={blocked || !sameReview}
          onClick={onSave}
        >
          {state.saving ? "Saving original…" : "Save reviewed routing edit"}
        </button>
      </div>
      {target &&
        state.preview &&
        state.preview.target === target &&
        sameReview && <Review preview={state.preview} />}
    </div>
  );
}

function changeText(change: SmithRoutingEditChange | null): string {
  if (!change)
    return "Original routing value will appear after the protected receipt is checked.";
  return change.kind === "default"
    ? change.smith
    : JSON.stringify(change.entries);
}

export function SmithRoutingEditReceiptsView({
  entries,
  canWrite,
  onCheck,
}: {
  entries: readonly SmithRoutingEditEntry[];
  canWrite: boolean;
  onCheck(requestId: string): void;
}): JSX.Element | null {
  if (!entries.length) return null;
  return (
    <section
      aria-label="Original Smith routing edit receipts"
      class="af-smith-panel af-smith-routing-receipts"
    >
      <h2>Original Smith routing edit receipts</h2>
      <p>
        Saved routing edits are never sent again automatically. An uncertain
        outcome can only be checked against its same protected original.
      </p>
      {entries.map((entry) => {
        const review =
          entry.receipt?.result.phase === "refused"
            ? null
            : (entry.receipt?.result.preview ?? null);
        return (
          <article
            key={entry.identity.requestId}
            aria-label={`Routing edit ${entry.identity.requestId}`}
          >
            <h3>
              {entry.state === "confirmed"
                ? "Confirmed routing edit"
                : entry.state === "refused"
                  ? "Refused routing edit"
                  : entry.state === "not-sent"
                    ? "Not sent"
                    : "Routing edit outcome held"}
            </h3>
            <dl>
              <dt>Request UUID</dt>
              <dd>
                <code>{entry.identity.requestId}</code>
              </dd>
              <dt>Original value</dt>
              <dd>
                {changeText(
                  entry.receipt?.original.change ??
                    entry.request?.change ??
                    null,
                )}
              </dd>
              <dt>Target / selector</dt>
              <dd>
                {entry.identity.target} · <code>{entry.identity.selector}</code>
              </dd>
              <dt>Original input SHA-256</dt>
              <dd>
                <code>{entry.identity.inputHash}</code>
              </dd>
              {entry.receipt?.result.phase === "refused" && (
                <>
                  <dt>Refusal</dt>
                  <dd>{entry.receipt.result.reason}</dd>
                </>
              )}
              {entry.receipt?.result.phase === "held" && (
                <>
                  <dt>Saved stage</dt>
                  <dd>{entry.receipt.result.stage}</dd>
                </>
              )}
              {review && (
                <>
                  <dt>Target before / after</dt>
                  <dd>
                    <code>
                      {showValue(review.review.targetBefore)} →{" "}
                      {showValue(review.review.targetAfter)}
                    </code>
                  </dd>
                  <dt>Effective before / after</dt>
                  <dd>
                    <code>
                      {showValue(review.review.effectiveBefore)} →{" "}
                      {showValue(review.review.effectiveAfter)}
                    </code>
                  </dd>
                  <dt>Provenance before / after</dt>
                  <dd>
                    <code>
                      {review.review.provenanceBefore} /{" "}
                      {review.review.provenanceAfter}
                    </code>
                  </dd>
                  <dt>Paired user revision</dt>
                  <dd>
                    <code>{review.expectedRevision.user}</code>
                  </dd>
                  <dt>Paired workspace revision</dt>
                  <dd>
                    <code>{review.expectedRevision.workspace}</code>
                  </dd>
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
                {entry.checking
                  ? "Checking original…"
                  : "Check original receipt"}
              </button>
            )}
            {entry.state === "not-sent" && (
              <p>
                Review again to create a new UUID. This saved original will not
                be retried.
              </p>
            )}
          </article>
        );
      })}
    </section>
  );
}
