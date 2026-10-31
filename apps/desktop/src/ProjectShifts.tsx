import { useEffect, useRef, useState } from "preact/hooks";
import { Button } from "../../../docs/js/ds/Button";
import { Dialog } from "../../../docs/js/ds/Dialog";
import type {
  ProjectShiftOptions,
  ProjectShiftReceipt,
} from "../../../types/project-shifts";
import { ObjectActivityTabs, ScopedProjectActivity } from "./ProjectActivity";
import { ProjectShiftAttempts } from "./ProjectShiftAttempts";
import { ProjectShiftListStatus } from "./ProjectShiftListStatus";
import type { ProjectShiftsClient } from "./project-shift-client";
import {
  newProjectShiftDraft,
  type ProjectShiftDraft,
  projectShiftPhaseLabel,
  projectShiftReasonLabel,
  reviewedProjectShift,
} from "./project-shift-composer";
import type { ProjectShiftScope } from "./project-shift-identities";
import "./project-shifts.css";

const money = (value: number) => `$${value.toFixed(2)}`;
const percent = (value: number | null) =>
  value === null ? "Not reported" : `${Math.round(value * 100)}%`;
const clock = (value: string) => new Date(value).toLocaleString();
const stoppable = new Set(["starting", "running", "throttled"]);
function elapsed(startedAt: string, now: number) {
  const minutes = Math.max(
    0,
    Math.floor((now - Date.parse(startedAt)) / 60000),
  );
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
function duration(milliseconds: number) {
  if (milliseconds % 3600000 === 0) return `${milliseconds / 3600000}h`;
  if (milliseconds % 60000 === 0) return `${milliseconds / 60000}m`;
  if (milliseconds % 1000 === 0) return `${milliseconds / 1000}s`;
  return `${milliseconds}ms`;
}

export function ProjectShifts({
  client,
  scope,
  writesAllowed,
  archived,
  originalRequestId,
  selectionError,
  onOriginalSelect,
}: {
  client: ProjectShiftsClient;
  scope: ProjectShiftScope;
  writesAllowed: boolean;
  archived: boolean;
  originalRequestId?: string | null;
  selectionError?: string;
  onOriginalSelect?: (requestId: string | null) => void;
}) {
  const view = client.get(scope);
  const [open, setOpen] = useState(false),
    [draft, setDraft] = useState<ProjectShiftDraft | null>(null),
    [formError, setFormError] = useState(""),
    [localAttending, setAttending] = useState<string | null>(null),
    [now, setNow] = useState(Date.now());
  const opener = useRef<HTMLElement>(null),
    formOwner = useRef(0),
    checkedOriginal = useRef<string | null>(null);
  const attending =
    originalRequestId === undefined ? localAttending : originalRequestId;
  useEffect(() => {
    if (!originalRequestId) {
      checkedOriginal.current = null;
      return;
    }
    if (view.loading) return;
    const key = `${scope.projectId}:${scope.workspace}:${originalRequestId}`;
    if (checkedOriginal.current === key) return;
    checkedOriginal.current = key;
    void client.check(scope, originalRequestId);
  }, [
    client,
    scope.projectId,
    scope.workspace,
    originalRequestId,
    view.loading,
  ]);
  const selectOriginal = (id: string | null) => {
    if (onOriginalSelect) onOriginalSelect(id);
    else setAttending(id);
  };
  const closeForm = () => {
    formOwner.current++;
    setOpen(false);
  };
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 5000);
    return () => window.clearInterval(timer);
  }, []);
  const held =
    !!view.identity ||
    !!view.pendingStart ||
    !!view.identityError ||
    !!view.pendingControl ||
    !!view.page?.items.some((item) => item.observation.phase !== "stopped");
  const startHeld = archived || !writesAllowed || view.busy || held;
  const options = view.options;
  const optionsFresh =
    !!options &&
    !view.optionsError &&
    !view.optionsLoading &&
    now - Date.parse(options.asOf) <= 30000;
  const receipt = view.page?.items.find(
    (row) => row.intent.request.requestId === attending,
  );
  const activityScopeReady =
    !view.loading &&
    !view.error &&
    !!view.page &&
    view.page.projectId === scope.projectId;
  const activityReadyFor = (selected: ProjectShiftReceipt) =>
    activityScopeReady &&
    selected.intent.projectId === scope.projectId &&
    selected.intent.workspace === scope.workspace &&
    selected.observation.requestId === selected.intent.request.requestId &&
    selected.observation.shiftId === selected.intent.shiftId &&
    !!view.page?.items.some(
      (item) =>
        item.intent.request.requestId === selected.intent.request.requestId &&
        item.intent.shiftId === selected.intent.shiftId &&
        item.intent.workspace === scope.workspace &&
        item.observation.requestId === selected.intent.request.requestId &&
        item.observation.shiftId === selected.intent.shiftId,
    );
  const openStart = async () => {
    if (startHeld) return;
    const owner = ++formOwner.current;
    opener.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    setDraft(null);
    setFormError("");
    setOpen(true);
    await client.loadOptions(scope);
    const current = client.get(scope);
    if (owner === formOwner.current && current.options && !current.optionsError)
      setDraft(newProjectShiftDraft(current.options));
  };
  const start = async () => {
    if (
      startHeld ||
      !optionsFresh ||
      !options ||
      !draft ||
      !options.availability.start
    )
      return;
    const reviewed = reviewedProjectShift(options, draft);
    if (!reviewed.ok) {
      setFormError(reviewed.reason);
      return;
    }
    await client.start(scope, reviewed.input);
    closeForm();
    const current = client.get(scope).original;
    if (current) selectOriginal(current.intent.request.requestId);
  };
  return (
    <section class="af-project-shifts" aria-label="Bounded project shifts">
      <div class="af-shift-section-heading">
        <div>
          <p class="af-wb-eyebrow">Bounded execution · attended locally</p>
          <h2>Project shifts</h2>
          <p>Shifts open draft pull requests and never merge.</p>
        </div>
        <div class="af-shift-actions">
          <Button
            aria-disabled={view.loading}
            onClick={() => {
              if (!view.loading) void client.refresh(scope);
            }}
          >
            Refresh shifts
          </Button>
          <Button
            variant="primary"
            aria-disabled={startHeld}
            onClick={() => void openStart()}
          >
            Start shift
          </Button>
        </div>
      </div>
      {archived && (
        <p>
          This project is archived. Existing originals and Stop or recovery
          remain available.
        </p>
      )}
      {!writesAllowed && (
        <p>Write connection unavailable. Original reads remain available.</p>
      )}
      {view.identityError && <p role="alert">{view.identityError}</p>}
      {selectionError && <p role="alert">{selectionError}</p>}
      {originalRequestId && !view.loading && !receipt && (
        <p role="alert">
          The selected original Shift is unavailable. No different original or
          private attempt was opened.
        </p>
      )}
      <ProjectShiftListStatus view={view} />
      {view.notice && (
        <p class="af-shift-notice" role="status">
          {view.notice}
        </p>
      )}
      {view.identity && (
        <div class="af-shift-held">
          <p>
            Original Start identity saved:{" "}
            <code>{view.identity.requestId}</code>. A replacement is held until
            this original is confirmed stopped. A saved identity alone does not
            prove Start reached the hearth.
          </p>
          <Button
            aria-disabled={view.loading}
            onClick={() => {
              if (!view.loading) void client.check(scope);
            }}
          >
            Check original Start
          </Button>
        </div>
      )}
      <div key="shift-list" class="af-shift-list" aria-busy={view.loading}>
        {view.page?.items.map((item) => (
          <ShiftRow
            key={item.intent.request.requestId}
            receipt={item}
            scope={scope}
            activityReady={activityReadyFor(item)}
            now={now}
            busy={view.busy || !!view.pendingControl || !writesAllowed}
            onCheck={() => {
              if (!view.loading)
                void client.check(scope, item.intent.request.requestId);
            }}
            onControl={(kind) =>
              void client.control(scope, item.intent.request.requestId, kind)
            }
            selected={attending === item.intent.request.requestId}
            onAttend={() =>
              selectOriginal(
                attending === item.intent.request.requestId
                  ? null
                  : item.intent.request.requestId,
              )
            }
          />
        ))}
      </div>
      {view.page && (
        <p class="af-session-note">
          Scoped observations checked{" "}
          <time dateTime={view.page.asOf}>{clock(view.page.asOf)}</time>.
          Closing this page leaves a running shift attended by its owned host.
        </p>
      )}
      {receipt && (
        <ProjectShiftAttempts
          key={receipt.intent.request.requestId}
          receipt={receipt}
        />
      )}
      <Dialog
        open={open}
        title="Review bounded project shift"
        titleId="af-project-shift-title"
        onClose={closeForm}
        returnFocusRef={opener}
        actions={
          <>
            <Button onClick={closeForm}>Cancel</Button>
            <Button
              variant="primary"
              aria-disabled={
                startHeld ||
                !draft ||
                !optionsFresh ||
                !options?.availability.start
              }
              onClick={() => void start()}
            >
              Start reviewed shift
            </Button>
          </>
        }
      >
        <p>
          Only Start sends the reviewed bounds. Opening, editing and Cancel do
          not launch a provider or change the queue.
        </p>
        {view.optionsLoading && (
          <p role="status">Reading current scope and defaults…</p>
        )}
        {view.optionsError && <p role="alert">{view.optionsError}</p>}
        {options && !options.availability.start && (
          <p role="alert">
            {options.availability.reason ?? "Attended Start is unavailable."}
          </p>
        )}
        {formError && <p role="alert">{formError}</p>}
        {options && draft && (
          <>
            <ProjectShiftFields
              options={options}
              draft={draft}
              setDraft={setDraft}
            />
            {!optionsFresh && (
              <p>Current choices need to be read again before Start.</p>
            )}
            <Button
              aria-disabled={view.optionsLoading}
              onClick={async () => {
                if (view.optionsLoading) return;
                const owner = formOwner.current;
                await client.loadOptions(scope);
                const latest = client.get(scope);
                if (
                  owner === formOwner.current &&
                  latest.options &&
                  !latest.optionsError
                ) {
                  setDraft(newProjectShiftDraft(latest.options));
                  setFormError("");
                }
              }}
            >
              Use current defaults
            </Button>
            <p class="af-session-note">
              Catalog revision {draft.expectedCatalogRevision}. Current project
              epic membership and label are checked again at admission. Any epic
              filter further narrows this project scope.
            </p>
          </>
        )}
      </Dialog>
    </section>
  );
}

export function ProjectShiftFields({
  options,
  draft,
  setDraft,
  disabled = false,
}: {
  options: ProjectShiftOptions;
  draft: ProjectShiftDraft;
  setDraft(value: ProjectShiftDraft): void;
  disabled?: boolean;
}) {
  const field = (
    key: keyof Omit<ProjectShiftDraft, "expectedCatalogRevision">,
    value: string,
  ) => setDraft({ ...draft, [key]: value });
  return (
    <div class="af-shift-fields">
      <label>
        Duration
        <input
          aria-label="Duration"
          disabled={disabled}
          value={draft.for}
          onInput={(e) => field("for", e.currentTarget.value)}
        />
        <small>
          {options.defaults.for.source} ·{" "}
          {duration(options.limits.durationMs[0])}–
          {duration(options.limits.durationMs[1])}
        </small>
      </label>
      <label>
        Concurrency
        <input
          aria-label="Concurrency"
          type="number"
          disabled={disabled}
          min={options.limits.concurrency[0]}
          max={options.limits.concurrency[1]}
          step="1"
          value={draft.concurrency}
          onInput={(e) => field("concurrency", e.currentTarget.value)}
        />
        <small>
          {options.defaults.concurrency.source} ·{" "}
          {options.limits.concurrency.join("–")}
        </small>
      </label>
      <label>
        Maximum beads
        <input
          aria-label="Maximum beads"
          type="number"
          disabled={disabled}
          min={options.limits.maxBeads[0]}
          max={options.limits.maxBeads[1]}
          step="1"
          value={draft.maxBeads}
          onInput={(e) => field("maxBeads", e.currentTarget.value)}
        />
        <small>
          {options.defaults.maxBeads.source} ·{" "}
          {options.limits.maxBeads.join("–")}
        </small>
      </label>
      <label>
        Spend cap (USD)
        <input
          aria-label="Spend cap (USD)"
          type="number"
          disabled={disabled}
          min="0"
          max={options.limits.maxUsd}
          step="any"
          value={draft.maxUsd}
          onInput={(e) => field("maxUsd", e.currentTarget.value)}
        />
        <small>
          {options.defaults.maxUsd.source} · Positive, at most{" "}
          {money(options.limits.maxUsd)}
        </small>
      </label>
      <label>
        Repair attempts
        <input
          aria-label="Repair attempts"
          type="number"
          disabled={disabled}
          min={options.limits.repairs[0]}
          max={options.limits.repairs[1]}
          step="1"
          value={draft.repairs}
          onInput={(e) => field("repairs", e.currentTarget.value)}
        />
        <small>
          {options.defaults.repairs.source} · {options.limits.repairs.join("–")}
        </small>
      </label>
      <label>
        Base branch
        <input
          aria-label="Base branch"
          disabled={disabled}
          value={draft.base}
          onInput={(e) => field("base", e.currentTarget.value)}
        />
        <small>{options.defaults.base.source} · Branch on origin</small>
      </label>
      <label>
        Epic filter
        <select
          aria-label="Epic filter"
          disabled={disabled}
          value={draft.epic}
          onChange={(e) => field("epic", e.currentTarget.value)}
        >
          <option value="">All current project epics</option>
          {options.epics.map((epic) => (
            <option key={epic.id} value={epic.id}>
              {epic.id} · {epic.title}
            </option>
          ))}
        </select>
      </label>
      <label>
        Smith override
        <select
          aria-label="Smith override"
          disabled={disabled}
          value={draft.smith}
          onChange={(e) => field("smith", e.currentTarget.value)}
        >
          <option value="">Resolve each bead’s smith</option>
          {options.smiths.names.map((smith) => (
            <option key={smith} value={smith}>
              {smith}
            </option>
          ))}
        </select>
        <small>
          Without an override, the existing bead, bench and default resolution
          applies.
        </small>
      </label>
      <label>
        Per-run timeout (optional)
        <input
          aria-label="Per-run timeout (optional)"
          disabled={disabled}
          placeholder="Use remaining shift time"
          value={draft.runTimeout}
          onInput={(e) => field("runTimeout", e.currentTarget.value)}
        />
        <small>
          {options.defaults.runTimeout.source}. Empty keeps the remaining
          shift-time budget; it is not an extra fixed timeout.
        </small>
      </label>
    </div>
  );
}

function ShiftRow({
  receipt,
  scope,
  activityReady,
  now,
  busy,
  onCheck,
  onControl,
  selected,
  onAttend,
}: {
  receipt: ProjectShiftReceipt;
  scope: ProjectShiftScope;
  activityReady: boolean;
  now: number;
  busy: boolean;
  onCheck(): void;
  onControl(kind: "stop" | "recover"): void;
  selected: boolean;
  onAttend(): void;
}) {
  const [tab, setTab] = useState<"details" | "activity">("details");
  const { observation, intent } = receipt,
    actual = observation.actual,
    reviewed = intent.request.options;
  const showActivity = tab === "activity" && activityReady;
  return (
    <article
      class="af-shift-row"
      data-shift={intent.shiftId}
      data-phase={observation.phase}
    >
      <div class="af-shift-section-heading">
        <div>
          <h3>{intent.shiftId}</h3>
          <p>
            <strong>{projectShiftPhaseLabel(observation.phase)}</strong>
          </p>
        </div>
        <div class="af-shift-actions">
          <Button onClick={onCheck}>Check original</Button>
          {stoppable.has(observation.phase) && (
            <Button
              aria-disabled={busy}
              onClick={() => {
                if (!busy) onControl("stop");
              }}
            >
              Stop shift
            </Button>
          )}
          {observation.phase === "needs-recovery" && (
            <Button
              aria-disabled={busy}
              onClick={() => {
                if (!busy) onControl("recover");
              }}
            >
              Recover original shift
            </Button>
          )}
          <Button aria-expanded={selected} onClick={onAttend}>
            {selected ? "Close private activity" : "Attend shift"}
          </Button>
        </div>
      </div>
      <ObjectActivityTabs
        label={`Shift views for ${intent.shiftId}`}
        detailLabel="Shift"
        selected={showActivity ? "activity" : "details"}
        activityAvailable={activityReady}
        onSelect={setTab}
      />
      <div
        role="tabpanel"
        aria-label={`Shift details for ${intent.shiftId}`}
        hidden={showActivity}
      >
        {observation.reason && (
          <p>{projectShiftReasonLabel(observation.reason)}</p>
        )}
        {actual ? (
          <dl class="af-shift-metrics">
            <div>
              <dt>Started</dt>
              <dd>
                <time dateTime={actual.startedAt}>
                  {clock(actual.startedAt)}
                </time>
              </dd>
            </div>
            <div>
              <dt>Elapsed / limit</dt>
              <dd>
                {elapsed(
                  actual.startedAt,
                  actual.endedAt ? Date.parse(actual.endedAt) : now,
                )}{" "}
                / {reviewed.for}
              </dd>
            </div>
            <div>
              <dt>Active / concurrency</dt>
              <dd>
                {actual.running} / {actual.concurrency}
              </dd>
            </div>
            <div>
              <dt>Admitted / maximum beads</dt>
              <dd>
                {actual.admitted ?? "Not reported"} / {actual.maxBeads}
              </dd>
            </div>
            <div>
              <dt>Reviewed / halted</dt>
              <dd>
                {actual.reviewed} / {actual.halted}
              </dd>
            </div>
            <div>
              <dt>Reported spend / cap</dt>
              <dd>
                {money(actual.spentUsd)} / {money(actual.maxUsd)}
                {actual.unpriced > 0 ? ` · ${actual.unpriced} unpriced` : ""}
              </dd>
            </div>
            <div>
              <dt>Last admission CPU / memory</dt>
              <dd>
                {actual.host
                  ? `${percent(actual.host.cpu)} / ${percent(actual.host.memory)}`
                  : "Not reported"}
              </dd>
            </div>
            <div>
              <dt>Throttle threshold</dt>
              <dd>{percent(actual.throttle)}</dd>
            </div>
            <div>
              <dt>Host sample</dt>
              <dd>{actual.host ? clock(actual.host.asOf) : "Not reported"}</dd>
            </div>
          </dl>
        ) : (
          <p>
            No correlated actual shift record is available. A reservation or
            launch marker does not prove provider execution.
          </p>
        )}
        <details>
          <summary>Reviewed original bounds</summary>
          <dl class="af-shift-metrics">
            <div>
              <dt>Duration</dt>
              <dd>{reviewed.for}</dd>
            </div>
            <div>
              <dt>Concurrency</dt>
              <dd>{reviewed.concurrency}</dd>
            </div>
            <div>
              <dt>Maximum beads</dt>
              <dd>{reviewed.maxBeads}</dd>
            </div>
            <div>
              <dt>Spend cap</dt>
              <dd>{money(reviewed.maxUsd)}</dd>
            </div>
            <div>
              <dt>Repairs</dt>
              <dd>{reviewed.repairs}</dd>
            </div>
            <div>
              <dt>Base</dt>
              <dd>{reviewed.base}</dd>
            </div>
            <div>
              <dt>Epic filter</dt>
              <dd>{reviewed.epic ?? "All current project epics"}</dd>
            </div>
            <div>
              <dt>Smith</dt>
              <dd>{reviewed.smith ?? "Resolve each bead’s smith"}</dd>
            </div>
            <div>
              <dt>Per-run timeout</dt>
              <dd>{reviewed.runTimeout ?? "Remaining shift time"}</dd>
            </div>
          </dl>
        </details>
      </div>
      {showActivity && (
        <div
          role="tabpanel"
          aria-label={`Shift Activity for ${intent.shiftId}`}
        >
          <ScopedProjectActivity
            key={JSON.stringify([
              scope.workspace,
              scope.projectId,
              intent.shiftId,
            ])}
            projectId={scope.projectId}
            workspace={scope.workspace}
            scope={{ shiftId: intent.shiftId }}
          />
        </div>
      )}
    </article>
  );
}
