import type { JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type {
  EventsPage,
  LedgerEvent,
  LedgerEventKind,
} from "../../../types/hearth";
import { EmptyState } from "../ds/EmptyState";
import { Field, Input, Select } from "../ds/Field";
import {
  describeEvent,
  filterByKinds,
  kindCounts,
  OVERSCAN,
  parseTimelineHash,
  ROW_PX,
  type TimelineQuery,
  type TimelineScope,
  timelineHash,
  visibleWindow,
} from "../timeline-model";
import { startTimelineRead, type TimelineView } from "../timeline-reader";
import { appStream, readOperatorRoute } from "../use-stream";

/** The list's height when the page has not measured it yet. */
const DEFAULT_VIEWPORT_PX = 480;

/**
 * The query in the address bar. The shell re-renders only when the route
 * changes, so a change of `?bead=` or `&kind=` is followed here.
 */
function useTimelineQuery(): TimelineQuery {
  const [query, setQuery] = useState(() =>
    parseTimelineHash(window.location.hash),
  );
  useEffect(() => {
    const follow = (): void =>
      setQuery(parseTimelineHash(window.location.hash));
    window.addEventListener("hashchange", follow);
    return () => window.removeEventListener("hashchange", follow);
  }, []);
  return query;
}

/** A scope's events, read again only when the scope changes (a kind change is the page's own). */
function useTimelineRead(scope: TimelineScope | null): TimelineView | null {
  // Kept with the scope it belongs to: on the render after the address moves
  // to another bead, the previous bead's events are not shown under its name.
  const [held, setHeld] = useState<{
    key: string;
    view: TimelineView;
  } | null>(null);
  const by = scope?.by;
  const id = scope?.id;
  const key = `${by}:${id}`;
  useEffect(() => {
    if (by === undefined || id === undefined) return;
    return startTimelineRead({
      scope: { by, id },
      read: (path) => readOperatorRoute<EventsPage>(path),
      client: appStream(),
      onChange: (view) => setHeld({ key: `${by}:${id}`, view }),
    });
  }, [by, id]);
  return held !== null && held.key === key ? held.view : null;
}

function go(query: TimelineQuery): void {
  window.location.hash = timelineHash(query);
}

/** One bead's or one run's ledger events, in ledger order, narrowed by kind. */
export function TimelineIsland(): JSX.Element {
  const query = useTimelineQuery();
  const view = useTimelineRead(query.scope);

  if (query.scope === null) return <ScopeForm />;
  if (view === null || (view.loading && view.events.length === 0))
    return <EmptyState title="Reading the ledger…" live />;
  if (view.events.length === 0 && view.error !== null)
    return (
      <EmptyState
        title="The Timeline needs the local dashboard"
        hint={
          <>
            It reads the hearth's ledger through the control plane. Start{" "}
            <code>bun run dashboard</code> at the harness root and open this
            page on its local address. ({view.error})
          </>
        }
      />
    );
  return <TimelineBody query={query} scope={query.scope} view={view} />;
}

/** Asks for a bead or a run when the address names neither. */
function ScopeForm(): JSX.Element {
  const [by, setBy] = useState<TimelineScope["by"]>("bead");
  const [id, setId] = useState("");
  const onSubmit = (event: Event): void => {
    event.preventDefault();
    const trimmed = id.trim();
    if (trimmed !== "") go({ scope: { by, id: trimmed }, kinds: [] });
  };
  return (
    <form class="af-timeline-scope" onSubmit={onSubmit}>
      <p class="af-prose">
        Choose a bead or a forge run. Its events are read from the hearth's
        ledger in the order they were recorded.
      </p>
      <Field label="Events of" id="tl-by">
        <Select
          id="tl-by"
          value={by}
          onChange={(event) =>
            setBy(
              (event.currentTarget as HTMLSelectElement).value === "run"
                ? "run"
                : "bead",
            )
          }
        >
          <option value="bead">a bead</option>
          <option value="run">a forge run</option>
        </Select>
      </Field>
      <Field label={by === "bead" ? "Bead id" : "Run slug"} id="tl-id">
        <Input
          id="tl-id"
          value={id}
          onInput={(event) => setId(event.currentTarget.value)}
          autocomplete="off"
        />
      </Field>
      {/* The ds Button is always type="button"; this one submits the form. */}
      <button
        type="submit"
        class="af-btn af-btn-primary"
        disabled={id.trim() === ""}
      >
        Show events
      </button>
    </form>
  );
}

function TimelineBody({
  query,
  scope,
  view,
}: {
  query: TimelineQuery;
  scope: TimelineScope;
  view: TimelineView;
}): JSX.Element {
  const counts = kindCounts(view.events);
  const shown = filterByKinds(view.events, query.kinds);
  const toggle = (kind: LedgerEventKind): void => {
    const chosen = query.kinds.includes(kind)
      ? query.kinds.filter((other) => other !== kind)
      : [...query.kinds, kind];
    go({ scope, kinds: chosen });
  };
  return (
    <section class="af-timeline" aria-label="Timeline">
      <p class="af-timeline-scope-line">
        Events of {scope.by === "bead" ? "bead" : "forge run"}{" "}
        <code>{scope.id}</code>: {shown.length} shown of {view.events.length}
        {view.loading ? " (reading more…)" : ""}
      </p>
      {view.cut ? (
        <p class="af-timeline-notice" role="status">
          More events match than the Timeline holds: the oldest{" "}
          {view.events.length} are shown, the kind filter applies to those, and
          newer events are not followed.
        </p>
      ) : null}
      {view.error !== null ? (
        <p class="af-timeline-notice" role="status">
          The last read failed ({view.error}); what is shown is from before.
        </p>
      ) : null}
      <div class="af-timeline-kinds" role="group" aria-label="Kinds">
        {counts.map(({ kind, count }) => (
          <button
            type="button"
            key={kind}
            class="af-timeline-chip"
            aria-pressed={query.kinds.includes(kind)}
            onClick={() => toggle(kind)}
          >
            {kind} <span class="af-timeline-count">{count}</span>
          </button>
        ))}
        {query.kinds.length > 0 ? (
          <button
            type="button"
            class="af-timeline-chip"
            onClick={() => go({ scope, kinds: [] })}
          >
            Every kind
          </button>
        ) : null}
      </div>
      {shown.length === 0 ? (
        <EmptyState
          title={
            view.events.length === 0
              ? "The ledger holds no events for this yet."
              : "No events of the chosen kinds."
          }
        />
      ) : (
        <EventList events={shown} />
      )}
    </section>
  );
}

/**
 * The events as a list in which only the rows in view (and a few either
 * side) are in the document: the rest is a spacer of the same height.
 */
function EventList({
  events,
}: {
  events: readonly LedgerEvent[];
}): JSX.Element {
  const box = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportPx, setViewportPx] = useState(DEFAULT_VIEWPORT_PX);

  useEffect(() => {
    const element = box.current;
    if (element === null) return;
    const measure = (): void => setViewportPx(element.clientHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const { first, last } = visibleWindow({
    scrollTop,
    viewportPx,
    rowPx: ROW_PX,
    count: events.length,
    overscan: OVERSCAN,
  });
  return (
    <div
      ref={box}
      class="af-timeline-list"
      // As tall as its rows (and its border), up to the stylesheet's maximum.
      style={{ height: `${events.length * ROW_PX + 2}px` }}
      onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
    >
      <ol
        class="af-timeline-rows"
        aria-label="Events"
        style={{ height: `${events.length * ROW_PX}px` }}
      >
        {events.slice(first, last).map((event, offset) => (
          <EventRow
            key={event.id}
            event={event}
            position={first + offset}
            total={events.length}
          />
        ))}
      </ol>
    </div>
  );
}

function EventRow({
  event,
  position,
  total,
}: {
  event: LedgerEvent;
  position: number;
  total: number;
}): JSX.Element {
  const line = describeEvent(event);
  const where = [
    event.beadId !== undefined ? `bead ${event.beadId}` : null,
    event.runId !== undefined ? `run ${event.runId}` : null,
    event.sessionId !== undefined ? `session ${event.sessionId}` : null,
  ].filter((part) => part !== null);
  const time = event.ts.slice(0, 19).replace("T", " ");
  return (
    <li
      class="af-timeline-row"
      data-kind={event.kind}
      data-event-id={event.id}
      aria-posinset={position + 1}
      aria-setsize={total}
      style={{ top: `${position * ROW_PX}px`, height: `${ROW_PX}px` }}
      title={`${event.ts} · ${event.kind} · ${line}${where.length > 0 ? ` · ${where.join(" · ")}` : ""}`}
    >
      <time class="af-timeline-time" dateTime={event.ts}>
        {time}
      </time>
      <span class="af-timeline-kind">{event.kind}</span>
      <span class="af-timeline-line">{line}</span>
      <span class="af-timeline-where">{where.join(" · ")}</span>
    </li>
  );
}
