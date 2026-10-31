import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "preact/hooks";
import { Button } from "../../../docs/js/ds/Button";
import { visibleWindow } from "../../../docs/js/timeline-model";
import { projectActivityFiltersSchema } from "../../../scripts/projects/activity-protocol";
import type { ProjectActivityFilters } from "../../../types/project-activity";
import { desktopHref } from "./navigation";
import {
  ACTIVITY_GROUPS,
  activityHref,
  emptyActivityFilters,
} from "./project-activity-model";
import type { ProjectActivityController } from "./use-project-activity";
import { useProjectActivity } from "./use-project-activity";
import "./project-activity.css";

const ROW_PX = 64;
const activityTabKeys = new Set(["ArrowLeft", "ArrowRight", "Home", "End"]);
function localTime(value: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 23);
}
const label = (key: string) =>
  key
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/^./, (value) => value.toUpperCase());

export function ProjectActivityFeed({
  controller,
  filters,
  filterError = "",
  onApply,
  onInspect,
  embedded = false,
  pinned,
}: {
  controller: ProjectActivityController;
  filters: ProjectActivityFilters | null;
  filterError?: string;
  onApply(filters: ProjectActivityFilters): void;
  onInspect(id: number): void;
  embedded?: boolean;
  pinned?: Partial<
    Pick<ProjectActivityFilters, "beadId" | "sessionId" | "runId" | "shiftId">
  >;
}) {
  const { client, view } = controller;
  const key = JSON.stringify(filters);
  const [draft, setDraft] = useState(filters ?? emptyActivityFilters()),
    [formError, setFormError] = useState("");
  useLayoutEffect(() => {
    setDraft(filters ?? emptyActivityFilters());
    setFormError("");
  }, [key]);
  const set = (
    field: keyof Omit<ProjectActivityFilters, "kinds">,
    value: string | null,
  ) => setDraft((current) => ({ ...current, [field]: value }));
  const group =
    ACTIVITY_GROUPS.find(
      (entry) => JSON.stringify(entry.kinds) === JSON.stringify(draft.kinds),
    )?.id ?? "custom";
  const filtered =
    !!filters &&
    (filters.kinds.length > 0 ||
      Object.entries(filters).some(
        ([field, value]) => field !== "kinds" && value !== null,
      ));
  const apply = (next: ProjectActivityFilters) => {
    const parsed = projectActivityFiltersSchema.safeParse({
      ...next,
      ...pinned,
    });
    if (!parsed.success) {
      setFormError(
        "These filters or their time range are invalid. Check the fields and try again.",
      );
      return;
    }
    onApply(parsed.data);
  };
  return (
    <section
      class={`af-project-activity${embedded ? " af-activity-embedded" : ""}`}
      aria-label="Project Activity"
    >
      <header class="af-activity-heading">
        <div>
          {embedded ? <h3>Activity</h3> : <h2>Project events</h2>}
          <p>
            {pinned?.beadId
              ? "Hearth-recorded bead activity · metadata only. Changes outside this hearth may be absent."
              : "Recorded project events. Metadata only; conversations stay in their own views."}
          </p>
        </div>
        <Button
          aria-disabled={!client || !!view?.loading}
          onClick={() => {
            if (client && !view?.loading) client.refresh();
          }}
        >
          Refresh Activity
        </Button>
      </header>
      <form
        class="af-activity-filters"
        onSubmit={(event) => {
          event.preventDefault();
          apply(draft);
        }}
      >
        <label>
          Kind
          <select
            aria-label="Activity kind"
            value={group}
            onChange={(event) =>
              setDraft((current) => ({
                ...current,
                kinds:
                  ACTIVITY_GROUPS.find(
                    (entry) => entry.id === event.currentTarget.value,
                  )?.kinds ?? current.kinds,
              }))
            }
          >
            {group === "custom" && <option value="custom">Custom kinds</option>}
            {ACTIVITY_GROUPS.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Recorded provider
          <input
            aria-label="Recorded provider filter"
            maxLength={200}
            value={draft.provider ?? ""}
            placeholder="All providers"
            onInput={(event) =>
              set("provider", event.currentTarget.value || null)
            }
          />
        </label>
        {(
          [
            ["beadId", "Bead"],
            ["sessionId", "Session"],
            ["runId", "Run"],
            ["shiftId", "Shift"],
          ] as const
        ).map(([field, title]) => (
          <label key={field}>
            {title}
            <input
              aria-label={`${title} filter`}
              maxLength={256}
              value={draft[field] ?? ""}
              readOnly={pinned?.[field] != null}
              onInput={(event) => set(field, event.currentTarget.value || null)}
            />
          </label>
        ))}
        {(
          [
            ["since", "From"],
            ["until", "Through"],
          ] as const
        ).map(([field, title]) => (
          <label key={field}>
            {title} (your time)
            <input
              type="datetime-local"
              step="0.001"
              aria-label={`${title} time`}
              value={localTime(draft[field])}
              onInput={(event) => {
                const value = event.currentTarget.value;
                if (!value) set(field, null);
                else {
                  const date = new Date(value);
                  if (!Number.isNaN(date.getTime()))
                    set(field, date.toISOString());
                }
              }}
            />
          </label>
        ))}
        <div class="af-activity-filter-actions">
          <button type="submit" class="af-btn af-btn-secondary">
            Apply filters
          </button>
          <Button onClick={() => apply(emptyActivityFilters())}>
            Clear filters
          </Button>
        </div>
      </form>
      {(filterError || formError) && (
        <p role="alert" class="af-activity-error">
          {filterError || formError}
        </p>
      )}
      {view?.error && (
        <p role="alert" class="af-activity-error">
          {view.error}{" "}
          {view.loaded && "The last verified events remain visible."}
        </p>
      )}
      {view?.problems.map((problem) => (
        <p class="af-activity-notice" key={problem}>
          {problem}
        </p>
      ))}
      {!filterError &&
        (!view?.loaded && !view?.error ? (
          <div
            class="af-activity-skeleton"
            role="status"
            aria-label="Loading Activity"
          >
            <span>Reading project Activity…</span>
            <i />
            <i />
            <i />
          </div>
        ) : view?.events.length ? (
          <ActivityRows controller={controller} onInspect={onInspect} />
        ) : view?.more ? (
          <p role="status">
            No matching rows in this page. More history remains; read more
            events to continue.
          </p>
        ) : view?.loaded && !view.error ? (
          <div class="af-activity-empty">
            <h3>
              {!view.membershipComplete
                ? "Activity is incomplete"
                : filtered
                  ? "No events match these filters"
                  : "No activity in this project yet"}
            </h3>
            <p>
              {!view.membershipComplete
                ? "Some project sources are unavailable. Refresh to check again; this read cannot prove an empty history."
                : filtered
                  ? "Clear or change the kind, provider, object or time filters to see more recorded events."
                  : "Activity fills as the project records sessions, gates, approvals and queue moves."}
            </p>
          </div>
        ) : null)}
      {view?.loaded && (
        <footer class="af-activity-source">
          <p>
            {view.events.length} {view.events.length === 1 ? "event" : "events"}
            {view.cut && " · newest retained events"}
            {view.loading && " · Reading…"}
            {view.more && " · More history remains"}
          </p>
          {!view.membershipComplete && (
            <p>Some project sources are incomplete; events may be missing.</p>
          )}
          {view.asOf && (
            <p>
              Checked{" "}
              <time dateTime={view.asOf}>
                {new Date(view.asOf).toLocaleString()}
              </time>
            </p>
          )}
          {view.notice && <p role="status">{view.notice}</p>}
          {view.more && (
            <Button
              aria-disabled={view.loading}
              onClick={() => {
                if (!view.loading) client?.loadMore();
              }}
            >
              Read more events
            </Button>
          )}
        </footer>
      )}
    </section>
  );
}

function ActivityRows({
  controller,
  onInspect,
}: {
  controller: ProjectActivityController;
  onInspect(id: number): void;
}) {
  const events = controller.view?.events ?? [];
  const listId = useId();
  const box = useRef<HTMLDivElement>(null);
  const [top, setTop] = useState(0),
    [height, setHeight] = useState(320),
    [active, setActive] = useState<number | null>(null);
  useEffect(() => {
    const node = box.current;
    if (!node) return;
    const measure = () => setHeight(node.clientHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  const { first, last } = visibleWindow({
    scrollTop: top,
    viewportPx: height,
    rowPx: ROW_PX,
    count: events.length,
    overscan: 5,
  });
  const activeIndex = Math.max(
    0,
    events.findIndex(
      (event) => event.id === (active ?? controller.view?.selectedId),
    ),
  );
  const choose = (index: number) => {
    const target = Math.max(0, Math.min(events.length - 1, index)),
      event = events[target],
      node = box.current;
    if (!event || !node) return;
    setActive(event.id);
    if (target * ROW_PX < node.scrollTop) node.scrollTop = target * ROW_PX;
    else if ((target + 1) * ROW_PX > node.scrollTop + node.clientHeight)
      node.scrollTop = (target + 1) * ROW_PX - node.clientHeight;
    setTop(node.scrollTop);
  };
  return (
    <>
      <p class="af-activity-keyboard">
        Use arrow keys to choose an event. Enter opens its metadata.
      </p>
      <div
        class="af-activity-list"
        ref={box}
        role="listbox"
        aria-label="Project activity"
        tabIndex={0}
        aria-activedescendant={
          activeIndex >= first && activeIndex < last
            ? `${listId}-event-${events[activeIndex]?.id}`
            : undefined
        }
        onScroll={(event) => setTop(event.currentTarget.scrollTop)}
        onKeyDown={(event) => {
          let target: number | null = null;
          if (event.key === "ArrowDown") target = activeIndex + 1;
          if (event.key === "ArrowUp") target = activeIndex - 1;
          if (event.key === "Home") target = 0;
          if (event.key === "End") target = events.length - 1;
          if (event.key === "PageDown")
            target = activeIndex + Math.max(1, Math.floor(height / ROW_PX));
          if (event.key === "PageUp")
            target = activeIndex - Math.max(1, Math.floor(height / ROW_PX));
          if (target !== null) {
            event.preventDefault();
            choose(target);
          }
          if (
            (event.key === "Enter" || event.key === " ") &&
            events[activeIndex]
          ) {
            event.preventDefault();
            onInspect(events[activeIndex].id);
          }
        }}
      >
        <div
          class="af-activity-spacer"
          style={{ height: `${events.length * ROW_PX}px` }}
        >
          {events.slice(first, last).map((event, offset) => (
            <div
              key={event.id}
              id={`${listId}-event-${event.id}`}
              role="option"
              tabIndex={-1}
              aria-selected={
                event.id === (active ?? controller.view?.selectedId)
              }
              aria-posinset={first + offset + 1}
              aria-setsize={events.length}
              class="af-activity-row"
              style={{
                top: `${(first + offset) * ROW_PX}px`,
                height: `${ROW_PX}px`,
              }}
              onClick={() => {
                setActive(event.id);
                onInspect(event.id);
              }}
              title={event.summary}
            >
              <time dateTime={event.at}>
                <small>{new Date(event.at).toLocaleDateString()}</small>
                {new Date(event.at).toLocaleTimeString()}
              </time>
              <span
                class="af-activity-actor"
                title={
                  event.actor
                    ? "Provider recorded on this ledger event"
                    : event.kind === "operator.action"
                      ? "Operator action recorded"
                      : "Provider not reported"
                }
              >
                {event.actor?.provider ??
                  (event.kind === "operator.action" ? "you" : "—")}
              </span>
              <span class="af-activity-line">
                <strong>{event.summary}</strong>
                <small>
                  {event.kind}
                  {event.beadId && ` · ${event.beadId}`}
                  {event.sessionId && " · Session"}
                  {event.runId && " · Run"}
                </small>
              </span>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

export function ProjectActivityInspector({
  projectId,
  controller,
}: {
  projectId: string;
  controller: ProjectActivityController;
}) {
  const { view, client } = controller,
    data = view?.detail,
    event = data?.event;
  return (
    <section class="af-activity-inspector" aria-label="Activity inspector">
      <h2>Event metadata</h2>
      {view?.selectedId === null || !view ? (
        <p>Choose an Activity event to inspect its recorded metadata.</p>
      ) : (
        <>
          <Button
            aria-disabled={view.detailLoading}
            onClick={() => {
              if (!view.detailLoading) client?.refreshDetail();
            }}
          >
            Refresh event metadata
          </Button>
          {view.detailLoading && (
            <p role="status">Verifying selected event metadata…</p>
          )}
          {view.detailStale && (
            <p role="status">
              Activity was refreshed after this metadata was checked. Refresh
              event metadata to verify it again.
            </p>
          )}
          {view.detailError && (
            <p role="alert" class="af-activity-error">
              {view.detailError}
              {data && " Previously verified metadata is kept."}
            </p>
          )}
          {event && (
            <>
              <h3>{event.summary}</h3>
              <p>
                Metadata only. Messages and tool input are not captured in this
                feed.
              </p>
              <dl>
                <dt>Event</dt>
                <dd>{event.id}</dd>
                <dt>Kind</dt>
                <dd>{event.kind}</dd>
                <dt>Recorded time</dt>
                <dd>
                  <time dateTime={event.at}>{event.at}</time>
                </dd>
                <dt>Recorded provider</dt>
                <dd>{event.actor?.provider ?? "Not reported"}</dd>
                <dt>Recorded model</dt>
                <dd>{event.actor?.model ?? "Not reported"}</dd>
                {event.actor?.effort && (
                  <>
                    <dt>Recorded effort</dt>
                    <dd>{event.actor.effort}</dd>
                  </>
                )}
                {event.actor?.smith && (
                  <>
                    <dt>Recorded smith</dt>
                    <dd>{event.actor.smith}</dd>
                  </>
                )}
              </dl>
              <p>
                This event does not confirm the provider conversation's identity
                or whether it is running.
              </p>
              <nav aria-label="Event objects">
                {event.beadId && (
                  <a
                    href={desktopHref({
                      projectId,
                      destination: "beads",
                      selection: { kind: "bead", id: event.beadId },
                    })}
                  >
                    Bead {event.beadId}
                  </a>
                )}
                {event.sessionId && (
                  <a
                    href={desktopHref({
                      projectId,
                      destination: "sessions",
                      selection: { kind: "session", id: event.sessionId },
                    })}
                  >
                    Session {event.sessionId}
                  </a>
                )}
                {event.runId && (
                  <span>Run {event.runId} · Run details unavailable here</span>
                )}
              </nav>
              <dl>
                {event.metadata.map((item) => (
                  <div key={item.key}>
                    <dt>{label(item.key)}</dt>
                    <dd>
                      <code>{String(item.value)}</code>
                    </dd>
                  </div>
                ))}
              </dl>
              {event.metadata.length === 0 && (
                <p>No additional metadata was supplied.</p>
              )}
              <p class="af-activity-source">
                Last verified{" "}
                <time dateTime={data.asOf}>
                  {new Date(data.asOf).toLocaleString()}
                </time>
              </p>
            </>
          )}
        </>
      )}
    </section>
  );
}

/** Embedded bead/session Activity uses the same controller and presentation without generic session actions. */
export function ScopedProjectActivity({
  projectId,
  workspace,
  scope,
}: {
  projectId: string;
  workspace: string;
  scope: Partial<
    Pick<ProjectActivityFilters, "beadId" | "sessionId" | "runId" | "shiftId">
  >;
}) {
  const [filters, setFilters] = useState<ProjectActivityFilters>({
      ...emptyActivityFilters(),
      ...scope,
    }),
    [selected, setSelected] = useState<number | null>(null);
  const controller = useProjectActivity(
    projectId,
    workspace,
    filters,
    selected,
  );
  return (
    <>
      <ProjectActivityFeed
        controller={controller}
        filters={filters}
        onApply={(value) => setFilters({ ...value, ...scope })}
        onInspect={setSelected}
        embedded
        pinned={scope}
      />
      <Button href={activityHref(projectId, filters, selected)}>
        Open in Activity
      </Button>
      {selected !== null && (
        <ProjectActivityInspector
          projectId={projectId}
          controller={controller}
        />
      )}
    </>
  );
}

export function ObjectActivityTabs({
  label,
  detailLabel,
  selected,
  activityAvailable,
  onSelect,
}: {
  label: string;
  detailLabel: string;
  selected: "details" | "activity";
  activityAvailable: boolean;
  onSelect(value: "details" | "activity"): void;
}) {
  return (
    <div
      class="af-beads-tabs"
      role="tablist"
      aria-label={label}
      onKeyDown={(event) => {
        if (!activityTabKeys.has(event.key)) return;
        const buttons = [
          ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
            'button[role="tab"]:not(:disabled)',
          ),
        ];
        const focused = document.activeElement;
        if (!(focused instanceof HTMLButtonElement)) return;
        const index = buttons.indexOf(focused);
        if (index < 0 || buttons.length === 0) return;
        const next =
          event.key === "Home"
            ? 0
            : event.key === "End"
              ? buttons.length - 1
              : (index + (event.key === "ArrowRight" ? 1 : -1) + buttons.length) %
                buttons.length;
        event.preventDefault();
        buttons[next]?.focus();
        buttons[next]?.click();
      }}
    >
      <button
        class="af-btn af-btn-secondary"
        type="button"
        role="tab"
        aria-selected={selected === "details"}
        tabIndex={selected === "details" ? 0 : -1}
        onClick={() => onSelect("details")}
      >
        {detailLabel}
      </button>
      {activityAvailable && (
        <button
          class="af-btn af-btn-secondary"
          type="button"
          role="tab"
          aria-selected={selected === "activity"}
          tabIndex={selected === "activity" ? 0 : -1}
          onClick={() => onSelect("activity")}
        >
          Activity
        </button>
      )}
    </div>
  );
}
