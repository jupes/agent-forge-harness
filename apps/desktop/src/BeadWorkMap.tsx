import type { JSX } from "preact";
import { useId, useMemo, useRef, useState } from "preact/hooks";
import { Button } from "../../../docs/js/ds/Button";
import type { ProjectBeadsPage } from "../../../types/project-beads";
import {
  buildBeadWorkMap,
  visibleBeadOutline,
  WORK_MAP_LIMITS,
  type BeadWorkMap as WorkMapModel,
} from "./beads-work-map-model";
import { desktopHref } from "./navigation";
import "./beads-work-map.css";

const words = (value: string) => value.replaceAll("_", " ");
const href = (projectId: string, id: string) =>
  `${desktopHref({ projectId, destination: "beads", selection: { kind: "bead", id } })}&view=full`;
interface Actions {
  projectId: string;
  selectedId: string | null;
  onSelect(id: string): void;
  onOpen(id: string): void;
}

export function BeadWorkMap({
  page,
  matchedIds,
  presentation,
  loading,
  error,
  ...actions
}: Actions & {
  page: ProjectBeadsPage;
  matchedIds: string[];
  presentation: "tree" | "dependencies";
  loading: boolean;
  error: string | null;
}) {
  const matchKey = JSON.stringify(matchedIds);
  const map = useMemo(
    () =>
      buildBeadWorkMap(
        page.projectId === actions.projectId ? page.beads : [],
        page.projectId === actions.projectId ? page.dependencies : [],
        new Set(matchedIds),
      ),
    [page, actions.projectId, matchKey],
  );
  if (page.projectId !== actions.projectId)
    return <p role="status">Waiting for this project’s tracker read…</p>;
  const closed = [...map.nodes.values()].filter(
    (node) => node.bead.status === "closed",
  ).length;
  const active = [...map.nodes.values()].filter(
    (node) => node.bead.status === "in_progress",
  ).length;
  const blocked = [...map.nodes.values()].filter(
    (node) => node.bead.status !== "closed" && node.bead.blocked,
  ).length;
  const cycles = [...map.nodes.values()].filter(
    (node) => node.dependencyCycle,
  ).length;
  return (
    <section class="af-workmap" aria-label="Beads work map">
      <div class="af-workmap-summary">
        <div>
          <strong>{map.matchCount}</strong> matching beads{" "}
          <span>of {map.nodes.size} in this project</span>
        </div>
        <div>
          <span>{closed} closed</span>
          <span>{active} in progress</span>
          <span>{blocked} blocked</span>
        </div>
      </div>
      <p class="af-workmap-caption">
        Tracker status and relationships · Forge execution is optional. Progress
        counts scoped descendants, including those hidden by filters.
      </p>
      {(error || loading || !page.complete) && (
        <p class="af-workmap-notice" role="status">
          {error
            ? "Showing the retained tracker read; refresh failed and statuses may be out of date."
            : loading
              ? "Refreshing; the previous tracker read remains visible."
              : "Partial project read: unavailable workspaces or epics are not represented."}
        </p>
      )}
      {map.problems.map((problem) => (
        <p class="af-workmap-notice" key={problem}>
          {problem}
        </p>
      ))}
      {map.unavailableBlockers > 0 && (
        <p class="af-workmap-notice">
          {map.unavailableBlockers} open prerequisite references are outside
          this project or unavailable. Their identities are not shown.
        </p>
      )}
      {cycles > 0 && (
        <p class="af-workmap-notice">
          Dependency cycle: {cycles} beads are in circular prerequisites in this
          scoped read. Inspect their relationships before scheduling work.
        </p>
      )}
      {presentation === "tree" ? (
        <WorkOutline map={map} {...actions} />
      ) : (
        <DependencyGraph map={map} {...actions} />
      )}
    </section>
  );
}

function Relations({
  map,
  id,
  projectId,
}: {
  map: WorkMapModel;
  id: string;
  projectId: string;
}) {
  const [open, setOpen] = useState(false),
    node = map.nodes.get(id)!;
  const groups = [
    ["Needs", node.prerequisites],
    ["Unblocks", node.dependents],
    ["Related (not blocking)", node.related],
  ] as const;
  const count = groups.reduce((sum, [, ids]) => sum + ids.length, 0);
  if (!count && !node.bead.unavailableBlockers)
    return <span class="af-workmap-muted">No scoped dependency links</span>;
  return (
    <details
      class="af-workmap-relations"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        Relationships · {count} scoped
        {node.bead.unavailableBlockers
          ? ` · ${node.bead.unavailableBlockers} unavailable prerequisites`
          : ""}
      </summary>
      {open &&
        groups.map(
          ([label, ids]) =>
            ids.length > 0 && (
              <div key={label}>
                <strong>{label}</strong>
                <ul>
                  {ids.map((target) => (
                    <li key={target}>
                      <a href={href(projectId, target)}>
                        {map.nodes.get(target)!.bead.title}{" "}
                        <code>{target}</code>
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            ),
        )}
    </details>
  );
}

function WorkOutline({ map, ...actions }: Actions & { map: WorkMapModel }) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set()),
    [focusId, setFocusId] = useState<string | null>(null);
  const references = useRef(new Map<string, HTMLButtonElement>());
  const visible = visibleBeadOutline(map, collapsed),
    visibleIds = new Set(visible.map((row) => row.id));
  const active = focusId && visibleIds.has(focusId) ? focusId : visible[0]?.id;
  const included = new Set(map.outline.map((row) => row.id));
  const roots = map.outline
    .filter((row) => row.depth === 0)
    .map((row) => row.id);
  const toggle = (id: string) =>
    setCollapsed((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const keyDown = (
    event: JSX.TargetedKeyboardEvent<HTMLButtonElement>,
    id: string,
  ) => {
    const index = visible.findIndex((row) => row.id === id),
      node = map.nodes.get(id)!;
    let target: string | undefined;
    if (event.key === "ArrowDown")
      target = visible[Math.min(index + 1, visible.length - 1)]?.id;
    else if (event.key === "ArrowUp")
      target = visible[Math.max(0, index - 1)]?.id;
    else if (event.key === "Home") target = visible[0]?.id;
    else if (event.key === "End") target = visible.at(-1)?.id;
    else if (event.key === "ArrowRight") {
      const child = node.children.find((child) => included.has(child));
      if (child && collapsed.has(id)) toggle(id);
      else target = child;
    } else if (event.key === "ArrowLeft") {
      if (
        node.children.some((child) => included.has(child)) &&
        !collapsed.has(id)
      )
        toggle(id);
      else target = node.parent ?? undefined;
    } else return;
    event.preventDefault();
    if (target) {
      setFocusId(target);
      references.current.get(target)?.focus();
    }
  };
  return (
    <div class="af-workmap-outline">
      <div class="af-workmap-tools">
        <Button onClick={() => setCollapsed(new Set())}>Expand all</Button>
        <Button onClick={() => setCollapsed(new Set(map.nodes.keys()))}>
          Collapse all
        </Button>
        <span>
          {visible.length} visible rows · {map.outline.length - map.matchCount}{" "}
          context rows
        </span>
      </div>
      <p class="af-workmap-caption" id="bead-outline-help">
        Use ↑/↓, Home/End to move; → expands, ← collapses. Enter inspects. Use
        Open for the full bead page.
      </p>
      <div
        class="af-workmap-tree"
        role="tree"
        aria-label="Bead hierarchy"
        aria-describedby="bead-outline-help"
      >
        {visible.map((row) => {
          const node = map.nodes.get(row.id)!,
            bead = node.bead,
            children = node.children.filter((id) => included.has(id));
          const siblings = node.parent
            ? map.nodes
                .get(node.parent)!
                .children.filter((id) => included.has(id))
            : roots;
          return (
            <div
              class={`af-workmap-tree-row${row.context ? " af-workmap-context" : ""}`}
              key={row.id}
              style={{ "--bead-depth": Math.min(row.depth, 10) }}
            >
              <div class="af-workmap-tree-main">
                {children.length ? (
                  <button
                    type="button"
                    class="af-workmap-disclosure"
                    aria-label={`${collapsed.has(row.id) ? "Expand" : "Collapse"} ${row.id}`}
                    aria-expanded={!collapsed.has(row.id)}
                    onClick={() => toggle(row.id)}
                  >
                    {collapsed.has(row.id) ? "▸" : "▾"}
                  </button>
                ) : (
                  <span class="af-workmap-leaf" aria-hidden="true">
                    ·
                  </span>
                )}
                <button
                  type="button"
                  role="treeitem"
                  aria-level={row.depth + 1}
                  aria-posinset={siblings.indexOf(row.id) + 1}
                  aria-setsize={siblings.length}
                  aria-expanded={
                    children.length ? !collapsed.has(row.id) : undefined
                  }
                  aria-selected={actions.selectedId === row.id}
                  tabIndex={active === row.id ? 0 : -1}
                  ref={(element) => {
                    if (element) references.current.set(row.id, element);
                    else references.current.delete(row.id);
                  }}
                  onFocus={() => setFocusId(row.id)}
                  onKeyDown={(event) => keyDown(event, row.id)}
                  onClick={() => actions.onSelect(row.id)}
                  onDblClick={() => actions.onOpen(row.id)}
                >
                  <span class="af-workmap-kind">{bead.type}</span>
                  <strong>{bead.title}</strong>
                  <code>{row.id}</code>
                  {row.context && <small>Context</small>}
                  <span class="af-workmap-state" data-status={bead.status}>
                    {words(bead.status)}
                    {bead.blocked && bead.status !== "closed"
                      ? " · blocked"
                      : ""}
                  </span>
                </button>
                <a
                  class="af-workmap-open"
                  href={href(actions.projectId, row.id)}
                  aria-label={`Open ${row.id}`}
                >
                  Open ↗
                </a>
              </div>
              <div class="af-workmap-tree-meta">
                {node.progress.total > 0 && (
                  <span class="af-workmap-progress">
                    <progress
                      max={node.progress.total}
                      value={node.progress.closed}
                      aria-label={`Closed descendants of ${row.id}`}
                    />
                    {node.progress.closed}/{node.progress.total} descendants
                    closed
                  </span>
                )}
                {bead.queue && <span>Queue: {words(bead.queue)}</span>}
                {node.hierarchyCycle && (
                  <span class="af-workmap-cycle">Hierarchy cycle</span>
                )}
                {node.dependencyCycle && (
                  <span class="af-workmap-cycle">Dependency cycle</span>
                )}
                {row.depth > 10 && <span>Level {row.depth + 1}</span>}
                <Relations
                  map={map}
                  id={row.id}
                  projectId={actions.projectId}
                />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function DependencyGraph({ map, ...actions }: Actions & { map: WorkMapModel }) {
  const viewport = useRef<HTMLDivElement>(null),
    dragging = useRef<{
      id: number;
      x: number;
      y: number;
      left: number;
      top: number;
    } | null>(null);
  const [zoom, setZoom] = useState(1),
    marker = useId(),
    graph = map.graph;
  const positions = new Map(graph.nodes.map((node) => [node.id, node]));
  const zoomTo = (next: number) => setZoom(Math.max(0.001, Math.min(2, next)));
  const pan = (x: number, y: number) =>
    viewport.current?.scrollBy({ left: x, top: y });
  const fit = () => {
    const box = viewport.current;
    if (!box) return;
    zoomTo(
      Math.min(
        1,
        (box.clientWidth - 24) / graph.width,
        (box.clientHeight - 24) / graph.height,
      ),
    );
    box.scrollTo({ left: 0, top: 0 });
  };
  const pointerDown: JSX.PointerEventHandler<HTMLDivElement> = (event) => {
    if (
      event.button !== 0 ||
      (event.target instanceof Element && event.target.closest("button,a"))
    )
      return;
    dragging.current = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      left: event.currentTarget.scrollLeft,
      top: event.currentTarget.scrollTop,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const pointerEnd: JSX.PointerEventHandler<HTMLDivElement> = (event) => {
    dragging.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  };
  return (
    <div class="af-workmap-dependencies">
      <div class="af-workmap-legend">
        <span>→ Prerequisite to blocked work</span>
        <span>Dashed: requires</span>
        <span>Dotted: related, not blocking</span>
        <span class="af-workmap-cycle">Amber: cycle</span>
      </div>
      <p class="af-workmap-caption">
        {graph.nodeCount} beads including {graph.contextCount} connected context
        beads · {graph.edgeCount} dependency links · {graph.filteredEdges} links
        outside current filters. No visible arrow does not prove work is
        unblocked.
      </p>
      {!graph.available ? (
        <p class="af-workmap-notice" role="status">
          Diagram paused at {graph.nodeCount} beads / {graph.edgeCount} links.
          The diagram supports {WORK_MAP_LIMITS.graphNodes} beads and{" "}
          {WORK_MAP_LIMITS.graphEdges} links. Narrow the filters or use the
          complete outline below; no tracker data was discarded.
        </p>
      ) : (
        <>
          <div
            class="af-workmap-tools"
            role="group"
            aria-label="Graph navigation"
          >
            <Button
              onClick={() => zoomTo(zoom / 1.25)}
              aria-label="Zoom graph out"
            >
              −
            </Button>
            <output aria-label="Graph zoom">
              {(zoom * 100).toFixed(zoom < 0.1 ? 1 : 0)}%
            </output>
            <Button
              onClick={() => zoomTo(zoom * 1.25)}
              aria-label="Zoom graph in"
            >
              +
            </Button>
            <Button onClick={fit}>Fit diagram</Button>
            <Button
              onClick={() => {
                zoomTo(1);
                viewport.current?.scrollTo({ left: 0, top: 0 });
              }}
            >
              Reset diagram
            </Button>
            <Button onClick={() => pan(-240, 0)} aria-label="Pan graph left">
              ←
            </Button>
            <Button onClick={() => pan(240, 0)} aria-label="Pan graph right">
              →
            </Button>
            <Button onClick={() => pan(0, -240)} aria-label="Pan graph up">
              ↑
            </Button>
            <Button onClick={() => pan(0, 240)} aria-label="Pan graph down">
              ↓
            </Button>
          </div>
          <div
            class="af-workmap-viewport"
            ref={viewport}
            // biome-ignore lint/a11y/noNoninteractiveTabindex: Named scroll region supports keyboard scrolling without dragging.
            tabIndex={0}
            role="region"
            aria-label="Dependency diagram; scroll or use graph navigation controls"
            onPointerDown={pointerDown}
            onPointerUp={pointerEnd}
            onPointerCancel={pointerEnd}
            onPointerMove={(event) => {
              const drag = dragging.current;
              if (drag?.id !== event.pointerId) return;
              event.currentTarget.scrollLeft =
                drag.left - event.clientX + drag.x;
              event.currentTarget.scrollTop = drag.top - event.clientY + drag.y;
            }}
          >
            <div
              style={{ width: graph.width * zoom, height: graph.height * zoom }}
            >
              <div
                class="af-workmap-stage"
                style={{
                  width: graph.width,
                  height: graph.height,
                  transform: `scale(${zoom})`,
                }}
              >
                <svg
                  class="af-workmap-edges"
                  width={graph.width}
                  height={graph.height}
                  aria-hidden="true"
                  focusable="false"
                >
                  <defs>
                    <marker
                      id={marker}
                      viewBox="0 0 10 10"
                      refX="9"
                      refY="5"
                      markerWidth="7"
                      markerHeight="7"
                      orient="auto-start-reverse"
                    >
                      <path d="M 0 0 L 10 5 L 0 10 z" fill="context-stroke" />
                    </marker>
                  </defs>
                  {graph.edges.map((edge) => {
                    const from = positions.get(edge.from)!,
                      to = positions.get(edge.to)!;
                    const start = from.x + 264,
                      end = to.x,
                      sy = from.y + 48,
                      ty = to.y + 48;
                    const path =
                      from.id === to.id
                        ? `M ${start} ${sy - 20} C ${start + 72} ${sy - 48} ${start + 72} ${sy + 48} ${start} ${sy + 20}`
                        : from.x === to.x
                          ? `M ${start} ${sy} C ${start + 56} ${sy} ${start + 56} ${ty} ${to.x + 264} ${ty}`
                          : `M ${start} ${sy} C ${(start + end) / 2} ${sy} ${(start + end) / 2} ${ty} ${end} ${ty}`;
                    return (
                      <path
                        key={`${edge.type}:${edge.from}:${edge.to}`}
                        d={path}
                        class={`af-workmap-edge af-workmap-edge-${edge.type}${edge.cyclic ? " af-workmap-edge-cycle" : ""}`}
                        markerEnd={
                          edge.type === "relates"
                            ? undefined
                            : `url(#${marker})`
                        }
                      />
                    );
                  })}
                </svg>
                {graph.nodes.map((node, index) => {
                  const bead = map.nodes.get(node.id)!.bead;
                  return (
                    <button
                      key={node.id}
                      type="button"
                      class={`af-workmap-node${node.context ? " af-workmap-context" : ""}${node.cyclic ? " af-workmap-node-cycle" : ""}`}
                      style={{ left: node.x, top: node.y }}
                      aria-pressed={actions.selectedId === node.id}
                      aria-label={`Inspect ${node.id}: ${bead.title}`}
                      aria-describedby={`${marker}-${index}-state ${marker}-${index}-context`}
                      title={`${node.id}: ${bead.title}`}
                      onClick={() => actions.onSelect(node.id)}
                      onDblClick={() => actions.onOpen(node.id)}
                    >
                      <span>
                        <code>{node.id}</code>
                        <small id={`${marker}-${index}-context`}>
                          {node.context ? "Context" : bead.type}
                          {node.cyclic ? " · cycle" : ""}
                        </small>
                      </span>
                      <strong>{bead.title}</strong>
                      <span
                        id={`${marker}-${index}-state`}
                        class="af-workmap-state"
                        data-status={bead.status}
                      >
                        {words(bead.status)}
                        {bead.blocked && bead.status !== "closed"
                          ? " · blocked"
                          : ""}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        </>
      )}
      <details class="af-workmap-equivalent" open={!graph.available}>
        <summary>
          Accessible hierarchy and dependency outline ·{" "}
          {map.graphOutline.length} rows
          {graph.available ? "" : " · full filtered read"}
        </summary>
        <p class="af-workmap-caption">
          Matching beads, connected context and their ancestors, with scoped
          prerequisite, dependent and related links.
        </p>
        <WorkOutline map={{ ...map, outline: map.graphOutline }} {...actions} />
      </details>
    </div>
  );
}
