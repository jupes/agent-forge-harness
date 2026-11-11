import { useEffect, useRef, useState } from "preact/hooks";
import {
  type InboxUsageRule,
  inboxUsageRulesDocumentSchema,
} from "../../../types/inbox-usage";
import { READINESS_PROVIDERS } from "../../../types/provider-readiness";
import type { ProjectUsageThresholdSettingsOwner } from "./project-usage-threshold-settings-client";

export interface UsageRuleDraft {
  id: string;
  provider: string;
  enabled: boolean;
  kind: string;
  unit: string;
  source: string;
  label: string;
  basis: string;
  comparison: string;
  threshold: string;
}
export type UsageSettingsView = ReturnType<
  ProjectUsageThresholdSettingsOwner["snapshot"]
>;
export function usageRulesDraft(
  rules: readonly Readonly<InboxUsageRule>[],
): UsageRuleDraft[] {
  return rules.map((rule) => ({
    id: rule.id,
    provider: rule.provider,
    enabled: rule.enabled,
    ...rule.selector,
    comparison: rule.comparison,
    threshold: String(rule.threshold),
  }));
}
export function parseUsageRulesDraft(
  rows: readonly UsageRuleDraft[],
): InboxUsageRule[] | null {
  if (rows.some((row) => !row.threshold.trim())) return null;
  const parsed = inboxUsageRulesDocumentSchema.shape.rules.safeParse(
    rows.map((row) => ({
      id: row.id,
      provider: row.provider,
      enabled: row.enabled,
      selector: {
        kind: row.kind,
        unit: row.unit,
        source: row.source,
        label: row.label,
        basis: row.basis,
      },
      comparison: row.comparison,
      threshold: Number(row.threshold),
    })),
  );
  return parsed.success ? parsed.data : null;
}
export interface UsageThresholdSettingsViewProps {
  owner: ProjectUsageThresholdSettingsOwner;
  snapshot: UsageSettingsView;
  draft: readonly UsageRuleDraft[];
  onDraft: (rows: UsageRuleDraft[]) => void;
  writesAllowed: boolean;
  canWrite: () => boolean;
}
function reserveReady(value: UsageSettingsView): boolean {
  return Boolean(
    !value.disposed &&
      !value.busy &&
      !value.held &&
      value.document &&
      value.documentFresh &&
      value.catalog?.fresh &&
      value.catalog.member &&
      !value.catalog.archived &&
      value.recoveryFresh &&
      value.recovery &&
      !value.recovery.pending.some(
        (row) =>
          row.original.projectId === value.document?.projectId &&
          row.original.workspace === value.document?.workspace,
      ),
  );
}
function retryReady(value: UsageSettingsView): boolean {
  const held = value.held;
  return Boolean(
    !value.disposed &&
      !value.busy &&
      held &&
      held.phase === "not-sent" &&
      held.uncertain === null &&
      !held.everUnknownReserve &&
      value.catalog?.fresh &&
      value.catalog.member &&
      !value.catalog.archived &&
      value.documentFresh &&
      value.recoveryFresh &&
      value.recovery &&
      value.document?.revision === held.original.expectedRevision &&
      value.catalog.revision === held.original.expectedCatalogRevision &&
      value.recovery.pending.every(
        (row) =>
          row.original.projectId !== held.original.projectId ||
          row.original.workspace !== held.original.workspace ||
          row.original.requestId === held.original.requestId,
      ),
  );
}
function RulesSummary({
  rules,
}: {
  rules: readonly Readonly<InboxUsageRule>[];
}) {
  return rules.length ? (
    <ul>
      {rules.map((rule) => (
        <li key={rule.id}>
          <code>{rule.id}</code>: {rule.provider} ·{" "}
          {rule.enabled ? "enabled" : "disabled"} · {rule.selector.kind} ·{" "}
          {rule.selector.label} · {rule.selector.source} · {rule.comparison}{" "}
          {rule.threshold} {rule.selector.unit} {rule.selector.basis}
        </li>
      ))}
    </ul>
  ) : (
    <p>No configured rules.</p>
  );
}
function OriginalSummary({
  original,
}: {
  original: NonNullable<UsageSettingsView["held"]>["original"];
}) {
  return (
    <div class="af-project-settings-review">
      <p>
        Original <code>{original.requestId}</code> · project{" "}
        <code>{original.projectId}</code> · workspace{" "}
        <code>{original.workspace}</code>
      </p>
      <p>
        Expected policy revision {original.expectedRevision}; expected catalog
        revision {original.expectedCatalogRevision}.
      </p>
      <RulesSummary rules={original.rules} />
    </div>
  );
}
export function UsageThresholdSettingsView({
  owner,
  snapshot,
  draft,
  onDraft,
  writesAllowed,
  canWrite,
}: UsageThresholdSettingsViewProps) {
  const parsed = parseUsageRulesDraft(draft);
  const writable = () =>
    writesAllowed && canWrite() && !owner.snapshot().disposed;
  const editable =
    writesAllowed && !snapshot.disposed && !snapshot.busy && !snapshot.held;
  const edit = (index: number, patch: Partial<UsageRuleDraft>) => {
    if (!writable() || owner.snapshot().busy || owner.snapshot().held) return;
    onDraft(
      draft.map((row, i) => (i === index ? { ...row, ...patch } : { ...row })),
    );
  };
  const held = snapshot.held;
  const reviewed = snapshot.review;
  const canAct = Boolean(
    writesAllowed &&
      !snapshot.disposed &&
      !snapshot.busy &&
      reviewed &&
      held?.phase === "reserved" &&
      held.uncertain === null,
  );
  const canApply =
    canAct &&
    Boolean(
      snapshot.catalog?.fresh &&
        snapshot.catalog.member &&
        !snapshot.catalog.archived &&
        snapshot.documentFresh &&
        snapshot.document?.revision === held?.original.expectedRevision &&
        snapshot.catalog.revision === held?.original.expectedCatalogRevision,
    );
  const act = (action: "apply" | "discard") => {
    if (!writable() || !(action === "apply" ? canApply : canAct)) return;
    const permit = owner.confirmReview(reviewed, action);
    return action === "apply" ? owner.apply(permit) : owner.discard(permit);
  };
  const retry =
    held?.phase === "not-sent" &&
    held.uncertain === null &&
    !held.everUnknownReserve;
  const select = (
    index: number,
    label: string,
    field: keyof UsageRuleDraft,
    values: readonly string[],
  ) => (
    <label>
      {label}
      <select
        aria-label={"Rule " + (index + 1) + ": " + label}
        value={String(draft[index]?.[field] ?? "")}
        disabled={!editable}
        onChange={(event) =>
          edit(index, { [field]: event.currentTarget.value })
        }
      >
        {values.map((value) => (
          <option key={value} value={value}>
            {value}
          </option>
        ))}
      </select>
    </label>
  );
  return (
    <section class="af-project-keeper" aria-label="Reported usage thresholds">
      <h3>Reported usage thresholds</h3>
      <p>
        Configure rules that match a provider's reported fields. Missing usage
        stays unknown; a rule does not establish an allowance or account
        identity.
      </p>
      {!writesAllowed && <p role="status">Usage settings are read-only.</p>}
      {snapshot.disposed && (
        <p role="status">
          This owner is closed. Retained outcomes below remain available for
          handoff.
        </p>
      )}
      {snapshot.busy && (
        <p role="status" aria-live="polite">
          Checking or saving usage settings…
        </p>
      )}
      {snapshot.notice && (
        <p role="status" aria-live="polite">
          {snapshot.notice}
        </p>
      )}
      {!snapshot.catalog?.fresh && (
        <p role="status">
          Project catalog verification is unavailable or stale. Apply and new
          reservations are blocked; an exact checked reservation can still be
          discarded.
        </p>
      )}
      {snapshot.catalog &&
        (!snapshot.catalog.member || snapshot.catalog.archived) && (
          <p role="status">
            The project is removed or archived. An exact reserved original can
            still be checked and discarded.
          </p>
        )}
      <button
        type="button"
        class="af-btn"
        disabled={snapshot.disposed || Boolean(snapshot.busy)}
        onClick={() => owner.refresh()}
      >
        Check current usage settings
      </button>
      <h4>Current policy</h4>
      {snapshot.document ? (
        <>
          <p>
            Policy revision {snapshot.document.revision} ·{" "}
            {snapshot.documentFresh
              ? "current checked values"
              : "last verified values; refresh required"}
            .
          </p>
          <RulesSummary rules={snapshot.document.rules} />
        </>
      ) : (
        <p>
          Current policy is unavailable. Check the settings before reserving
          rules.
        </p>
      )}
      {!snapshot.recoveryFresh && (
        <p>
          Complete pending-original discovery is unavailable or stale. New
          reservations remain blocked.
        </p>
      )}
      <form
        class="af-project-settings-form"
        aria-label="Usage threshold rules"
        onSubmit={(event) => {
          event.preventDefault();
          if (writable() && reserveReady(owner.snapshot()) && parsed)
            return owner.reserve(parsed);
        }}
      >
        <h4>Draft rules</h4>
        {!draft.length && <p>This draft explicitly configures no rules.</p>}
        {draft.map((row, index) => (
          <fieldset key={row.id} disabled={!editable}>
            <legend>Rule {index + 1}</legend>
            <p>
              Rule ID <code>{row.id}</code>
            </p>
            {select(index, "Provider", "provider", READINESS_PROVIDERS)}
            <label>
              <input
                type="checkbox"
                aria-label={"Rule " + (index + 1) + ": Enabled"}
                checked={row.enabled}
                disabled={!editable}
                onChange={(event) =>
                  edit(index, { enabled: event.currentTarget.checked })
                }
              />
              Enabled
            </label>
            {select(index, "Reported kind", "kind", [
              "subscription-window",
              "api-balance",
            ])}
            {select(index, "Unit", "unit", [
              "percent",
              "tokens",
              "requests",
              "usd",
            ])}
            {select(index, "Report source", "source", [
              "provider-cli",
              "provider-api",
            ])}
            <label>
              Exact reported label
              <input
                type="text"
                maxLength={2048}
                value={row.label}
                aria-label={"Rule " + (index + 1) + ": Exact reported label"}
                disabled={!editable}
                onInput={(event) =>
                  edit(index, { label: event.currentTarget.value })
                }
              />
            </label>
            {select(index, "Reported basis", "basis", ["used", "remaining"])}
            {select(index, "Comparison", "comparison", ["at-least", "at-most"])}
            <label>
              Threshold
              <input
                type="number"
                min="0"
                max={row.unit === "percent" ? "100" : undefined}
                step="any"
                aria-label={"Rule " + (index + 1) + ": Threshold"}
                value={row.threshold}
                disabled={!editable}
                onInput={(event) =>
                  edit(index, { threshold: event.currentTarget.value })
                }
              />
            </label>
            <button
              type="button"
              class="af-btn"
              disabled={!editable}
              onClick={() => {
                if (
                  writable() &&
                  !owner.snapshot().busy &&
                  !owner.snapshot().held
                )
                  onDraft(
                    draft
                      .filter((_, i) => i !== index)
                      .map((value) => ({ ...value })),
                  );
              }}
            >
              Remove rule {index + 1}
            </button>
          </fieldset>
        ))}
        {!parsed && (
          <p role="status">
            Enter complete valid rules. Thresholds must be finite nonnegative
            numbers; percentages cannot exceed 100. Rule IDs must be unique.
          </p>
        )}
        <button
          type="button"
          class="af-btn"
          disabled={
            !editable || draft.length >= 100 || !globalThis.crypto?.randomUUID
          }
          onClick={() => {
            if (
              !writable() ||
              owner.snapshot().busy ||
              owner.snapshot().held ||
              draft.length >= 100
            )
              return;
            try {
              const id = globalThis.crypto.randomUUID();
              onDraft([
                ...draft.map((row) => ({ ...row })),
                {
                  id,
                  provider: READINESS_PROVIDERS[0],
                  enabled: true,
                  kind: "subscription-window",
                  unit: "percent",
                  source: "provider-cli",
                  label: "",
                  basis: "used",
                  comparison: "at-least",
                  threshold: "",
                },
              ]);
            } catch {
              /* No rule or request is invented without a generated ID. */
            }
          }}
        >
          Add rule
        </button>
        <p>
          Up to 100 rules. Reserving does not apply changes; check the exact
          original and review it before applying.
        </p>
        <button
          type="submit"
          class="af-btn af-btn-primary"
          disabled={!writesAllowed || !reserveReady(snapshot) || !parsed}
        >
          Reserve these rules
        </button>
      </form>
      {held && (
        <div class="af-project-settings-review">
          <h4>Retained original</h4>
          <OriginalSummary original={held.original} />
          <p>
            State: {held.phase}
            {held.uncertain ? "; unknown " + held.uncertain + " outcome" : ""}.
            Missing reads and current values do not settle this original.
          </p>
          <button
            type="button"
            class="af-btn"
            disabled={snapshot.disposed || Boolean(snapshot.busy)}
            onClick={() => owner.check(held.original.requestId)}
          >
            Check this exact original
          </button>
          {retry && (
            <button
              type="button"
              class="af-btn"
              disabled={!writesAllowed || !retryReady(snapshot)}
              onClick={() => {
                if (writable() && retryReady(owner.snapshot()))
                  return owner.retryReserveNotSent();
              }}
            >
              Retry this known not-sent Reserve
            </button>
          )}
          {reviewed && (
            <div>
              <p>
                Review the complete retained original above. Apply changes that
                exact original; Discard closes the reservation without changing
                the policy.
              </p>
              <button
                type="button"
                class="af-btn af-btn-primary"
                disabled={!canApply}
                onClick={() => act("apply")}
              >
                Apply this reviewed original
              </button>
              <button
                type="button"
                class="af-btn"
                disabled={!canAct}
                onClick={() => act("discard")}
              >
                Discard this reviewed original
              </button>
            </div>
          )}
        </div>
      )}
      {snapshot.lastTerminal && (
        <div class="af-project-settings-review">
          <h4>Last verified original outcome: {snapshot.lastTerminal.phase}</h4>
          <OriginalSummary original={snapshot.lastTerminal.original} />
          <p>
            This immutable outcome describes that original; the current policy
            may be newer.
          </p>
        </div>
      )}
      {snapshot.recovery && (
        <div>
          <h4>Captured pending originals</h4>
          <p>
            {snapshot.recoveryFresh
              ? "Complete checked inventory"
              : "Last verified inventory; refresh required"}{" "}
            · {snapshot.recovery.pending.length} originals.
          </p>
          <ul>
            {snapshot.recovery.pending.map((row) => (
              <li key={row.original.requestId}>
                <code>{row.original.requestId}</code> · project{" "}
                <code>{row.original.projectId}</code> · workspace{" "}
                <code>{row.original.workspace}</code>.
                {row.original.requestId !== held?.original.requestId &&
                  " Open that project's workspace to check this original; this view grants no action on it."}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
export function observeUsageThresholdSettings(
  owner: ProjectUsageThresholdSettingsOwner,
  onSnapshot: (snapshot: UsageSettingsView) => void,
): () => void {
  let live = true;
  const emit = () => {
    if (live) {
      try {
        onSnapshot(owner.snapshot());
      } catch {
        /* Observers own no mutation authority. */
      }
    }
  };
  const unsubscribe = owner.subscribe(emit);
  emit();
  return () => {
    live = false;
    unsubscribe();
  };
}
export function ProjectUsageThresholdSettings({
  owner,
  writesAllowed,
}: {
  owner: ProjectUsageThresholdSettingsOwner;
  writesAllowed: boolean;
}) {
  const selection = useRef({ owner, token: {} });
  if (selection.current.owner !== owner)
    selection.current = { owner, token: {} };
  const selected = selection.current;
  const active = useRef<typeof selected | null>(null);
  const current = useRef({ owner, writesAllowed });
  current.current = { owner, writesAllowed };
  const [, setObserved] = useState(() => ({
    owner,
    snapshot: owner.snapshot(),
  }));
  const [draft, setDraft] = useState<{
    owner: ProjectUsageThresholdSettingsOwner;
    rows: UsageRuleDraft[];
  } | null>(null);
  useEffect(() => {
    active.current = selected;
    const off = observeUsageThresholdSettings(owner, (snapshot) => {
      if (selection.current === selected) setObserved({ owner, snapshot });
    });
    return () => {
      if (active.current === selected) active.current = null;
      off();
    };
  }, [owner, selected]);
  const snapshot = owner.snapshot();
  const rows =
    draft?.owner === owner
      ? draft.rows
      : usageRulesDraft(snapshot.document?.rules ?? []);
  return (
    <UsageThresholdSettingsView
      owner={owner}
      snapshot={snapshot}
      draft={rows}
      writesAllowed={writesAllowed}
      canWrite={() =>
        active.current === selected &&
        selection.current === selected &&
        current.current.owner === owner &&
        current.current.writesAllowed
      }
      onDraft={(rows) => {
        if (current.current.owner === owner) setDraft({ owner, rows });
      }}
    />
  );
}
