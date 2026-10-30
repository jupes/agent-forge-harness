import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { Button } from "../../../docs/js/ds/Button";
import { EmptyState } from "../../../docs/js/ds/EmptyState";
import { COLUMN_LABELS } from "../../../docs/js/workbench-model";
import type { OperatorMove } from "../../../scripts/scheduler/queue-table";
import { QUEUE_STATES, type QueueState } from "../../../types/hearth";
import type {
  ProjectWorkbenchCard,
  ProjectWorkbenchPage,
} from "../../../types/project-workbench";
import { BeadWriteNotices } from "./BeadWrites";
import { desktopHref } from "./navigation";
import { beadHref } from "./ProjectBeads";
import type { DesktopBeadWrites } from "./use-bead-writes";
import "./workbench.css";

const labels: Record<OperatorMove, string> = {
  propose: "Propose",
  approve: "Approve",
  queue: "Queue",
  pause: "Pause",
  resume: "Resume",
  reassign: "Reassign",
};
const emptyFilters = { query: "", priority: "", state: "", smith: "" };
const percent = (n: number | null | undefined) =>
  n === null || n === undefined ? "—" : `${Math.round(n * 100)}%`;

export function ProjectWorkbench({
  projectId,
  page,
  error,
  loading,
  reload,
  writes,
  selectedId,
  onSelect,
  onCouncilPrefill,
  shifts,
}: {
  projectId: string;
  page: ProjectWorkbenchPage | null;
  error: string | null;
  loading: boolean;
  reload(): void;
  writes: DesktopBeadWrites;
  selectedId: string | null;
  onSelect(id: string): void;
  onCouncilPrefill?: ((id: string, workspace: string) => void) | undefined;
  shifts?: ComponentChildren;
}) {
  const [filters, setFilters] = useState(emptyFilters),
    [doneOpen, setDoneOpen] = useState(false),
    [now, setNow] = useState(Date.now());
  const root = useRef<HTMLElement>(null);
  const [focusTarget, setFocusTarget] = useState<{
    id: string;
    state: QueueState;
    smith: string | undefined;
  } | null>(null);
  useEffect(() => {
    if (!focusTarget || loading) return;
    const { id: focusId, state, smith } = focusTarget;
    if (
      !page?.cards.some(
        (card) =>
          card.entry.beadId === focusId &&
          card.entry.state === state &&
          (smith === undefined || card.entry.smith === smith),
      )
    )
      return;
    const frame = requestAnimationFrame(() => {
      const current = root.current;
      if (!current) return;
      const active = document.activeElement;
      if (
        active === document.body ||
        active?.closest(`[data-bead="${CSS.escape(focusId)}"]`)
      ) {
        (
          current.querySelector<HTMLButtonElement>(
            `[data-bead="${CSS.escape(focusId)}"] button[data-inspect]`,
          ) ?? current.querySelector<HTMLButtonElement>("[data-refresh]")
        )?.focus();
      }
      setFocusTarget(null);
    });
    return () => cancelAnimationFrame(frame);
  }, [focusTarget, loading, page]);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 5000);
    return () => window.clearInterval(timer);
  }, []);
  const fresh =
    !!page &&
    !error &&
    Number.isFinite(Date.parse(page.asOf)) &&
    now - Date.parse(page.asOf) < 30000;
  const scope = { projectId, workspace: page?.workspace ?? "" };
  const blocked =
    !page || !fresh || !writes.writesAllowed || writes.client.held(scope);
  const held = blocked || loading;
  const rows = page?.cards ?? [];
  const cards = rows
    .filter(
      ({ entry, smith }) =>
        (!filters.query ||
          `${entry.beadId} ${entry.title}`
            .toLowerCase()
            .includes(filters.query.trim().toLowerCase())) &&
        (!filters.priority || String(entry.priority) === filters.priority) &&
        (!filters.state || entry.state === filters.state) &&
        (!filters.smith || smith.name === filters.smith),
    )
    .sort(
      (a, b) =>
        (a.entry.priority ?? 5) - (b.entry.priority ?? 5) ||
        a.entry.beadId.localeCompare(b.entry.beadId, "en", { numeric: true }),
    );
  const move = async (
    card: ProjectWorkbenchCard,
    action: OperatorMove,
    smith?: string,
  ) => {
    if (held || !card.moves.includes(action)) return;
    if (
      action === "reassign" &&
      (!smith || !page?.smiths?.names.includes(smith))
    )
      return;
    const result = await writes.client.act(
      scope,
      action,
      card.entry.beadId,
      smith,
    );
    if (result?.phase === "done")
      setFocusTarget({
        id: card.entry.beadId,
        state: result.queueTo ?? card.entry.state,
        smith: action === "reassign" ? smith : undefined,
      });
    if (result?.phase === "done" || result?.phase === "unknown") reload();
  };
  return (
    <section
      class="af-project-workbench"
      aria-label="Project Workbench"
      aria-busy={loading}
      ref={root}
    >
      <header class="af-wb-header">
        <div>
          <p class="af-wb-eyebrow">Project scope · approval queue</p>
          <h1>Workbench</h1>
          <p>
            Approve deliberately. Queue work for a shift. Every wait says why.
          </p>
        </div>
        <Button
          data-refresh
          onClick={() => {
            if (!loading) reload();
          }}
          aria-disabled={loading}
        >
          Refresh Workbench
        </Button>
      </header>
      {shifts}
      <div class="af-wb-toolbar">
        <label class="af-wb-search">
          Search
          <input
            type="search"
            aria-label="Search Workbench by id or title"
            value={filters.query}
            onInput={(e) =>
              setFilters({ ...filters, query: e.currentTarget.value })
            }
            placeholder="Id or title"
          />
        </label>
        <label>
          Priority
          <select
            aria-label="Filter Workbench by priority"
            value={filters.priority}
            onChange={(e) =>
              setFilters({ ...filters, priority: e.currentTarget.value })
            }
          >
            <option value="">All priorities</option>
            {[0, 1, 2, 3, 4].map((n) => (
              <option key={n} value={n}>
                P{n}
              </option>
            ))}
          </select>
        </label>
        <label>
          Queue state
          <select
            aria-label="Filter Workbench by queue state"
            value={filters.state}
            onChange={(e) =>
              setFilters({ ...filters, state: e.currentTarget.value })
            }
          >
            <option value="">All states</option>
            {QUEUE_STATES.map((state) => (
              <option key={state} value={state}>
                {COLUMN_LABELS[state]}
              </option>
            ))}
          </select>
        </label>
        <label>
          Smith
          <select
            aria-label="Filter Workbench by smith"
            value={filters.smith}
            onChange={(e) =>
              setFilters({ ...filters, smith: e.currentTarget.value })
            }
          >
            <option value="">All smiths</option>
            {[
              ...new Set([
                ...rows.flatMap((card) =>
                  card.entry.smith ? [card.entry.smith] : [],
                ),
                ...(page?.smiths?.names ?? []),
              ]),
            ]
              .sort()
              .map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
          </select>
        </label>
        <Button onClick={() => setFilters(emptyFilters)}>
          Clear Workbench filters
        </Button>
      </div>
      {error && (
        <p role="alert">
          {error} The last read may be out of date. Refresh before moving a
          bead.
        </p>
      )}
      {loading && !page && <p role="status">Loading project Workbench…</p>}
      {page?.problems.map((problem) => (
        <p class="af-wb-notice" key={problem}>
          {problem}
        </p>
      ))}
      {page && (
        <p class="af-wb-read">
          {cards.length} of {rows.length} queue labels · Read{" "}
          <time dateTime={page.asOf}>
            {new Date(page.asOf).toLocaleTimeString()}
          </time>{" "}
          · Host CPU {percent(page.host?.cpu)} · memory{" "}
          {percent(page.host?.memory)} · throttle{" "}
          {percent(page.host?.threshold)}
          {!fresh && " · Observation out of date; refresh required"}
        </p>
      )}
      <BeadWriteNotices writes={writes} scope={scope} />
      {page && rows.length === 0 ? (
        <EmptyState
          title={
            page.complete
              ? "No beads in the approval queue."
              : "No queue cards were observed in the available scope."
          }
          hint={
            page.complete
              ? "Propose scoped beads from their bead panel, then approve and queue them here."
              : "Review the source warnings and refresh before treating this queue as empty."
          }
        >
          <Button
            href={desktopHref({
              projectId,
              destination: "beads",
              selection: null,
            })}
          >
            Open project beads
          </Button>
        </EmptyState>
      ) : page && cards.length === 0 ? (
        <EmptyState
          title="No beads match these filters."
          hint="Clear filters to see the project's queue."
        />
      ) : (
        page && (
          <>
            <p class="af-wb-read">
              Scroll across the queue or use Tab to move between its controls.
              Running, Review and Done follow recorded work.
            </p>
            <div class="af-wb-board" role="group" aria-label="Queue columns">
              {QUEUE_STATES.map((state) => {
                const group = cards.filter(
                  (card) => card.entry.state === state,
                );
                return (
                  <section
                    class={`af-wb-column is-${state}`}
                    aria-label={`${COLUMN_LABELS[state]} queue`}
                    data-column={state}
                    key={state}
                  >
                    <header>
                      <h2>
                        {COLUMN_LABELS[state]} <span>{group.length}</span>
                      </h2>
                      {state === "done" && (
                        <Button
                          aria-expanded={doneOpen}
                          onClick={() => setDoneOpen(!doneOpen)}
                        >
                          {doneOpen ? "Hide" : "Show"} Done ({group.length})
                        </Button>
                      )}
                    </header>
                    {state === "done" && !doneOpen ? (
                      <p class="af-wb-muted">Done is collapsed.</p>
                    ) : group.length === 0 ? (
                      <p class="af-wb-muted">No {state} beads.</p>
                    ) : (
                      group.map((card) => (
                        <WorkbenchCard
                          key={`${card.entry.state}:${card.entry.beadId}`}
                          card={card}
                          page={page}
                          held={held}
                          blocked={blocked}
                          fresh={fresh}
                          now={now}
                          selected={selectedId === card.entry.beadId}
                          onSelect={() => onSelect(card.entry.beadId)}
                          onCouncilPrefill={onCouncilPrefill}
                          onMove={(action, smith) => {
                            void move(card, action, smith);
                          }}
                        />
                      ))
                    )}
                  </section>
                );
              })}
            </div>
          </>
        )
      )}
    </section>
  );
}

function WorkbenchCard({
  card,
  page,
  held,
  blocked,
  fresh,
  now,
  selected,
  onSelect,
  onCouncilPrefill,
  onMove,
}: {
  card: ProjectWorkbenchCard;
  page: ProjectWorkbenchPage;
  held: boolean;
  blocked: boolean;
  fresh: boolean;
  now: number;
  selected: boolean;
  onSelect(): void;
  onCouncilPrefill?: ((id: string, workspace: string) => void) | undefined;
  onMove(action: OperatorMove, smith?: string): void;
}) {
  const { entry } = card;
  const [smith, setSmith] = useState("");
  const choices = page.smiths?.names ?? [];
  const assigned = card.smith.name;
  const chosen = choices.includes(smith) ? smith : "";
  const started = card.session?.startedAt
    ? Date.parse(card.session.startedAt)
    : NaN;
  return (
    <article
      class={`af-wb-card${selected ? " is-selected" : ""}`}
      data-bead={entry.beadId}
      aria-label={`${entry.title} (${entry.beadId})`}
    >
      <div class="af-wb-card-meta">
        <code>{entry.beadId}</code>
        <span>
          {entry.priority === undefined ? "Priority —" : `P${entry.priority}`}
        </span>
        <span>{card.complexity ?? "Complexity —"}</span>
      </div>
      <button
        type="button"
        class="af-wb-card-title"
        data-inspect
        aria-label={`Inspect ${entry.beadId}: ${entry.title}`}
        aria-pressed={selected}
        onClick={onSelect}
      >
        {entry.title}
      </button>
      <Button
        onClick={() => onCouncilPrefill?.(entry.beadId, page.workspace)}
        disabled={!onCouncilPrefill || !fresh}
      >
        Review bead in Council
      </Button>
      <p class="af-wb-muted">
        {assigned
          ? card.smith.via === "bead"
            ? `smith ${assigned}`
            : card.smith.via === "bench"
              ? `bench smith ${assigned}`
              : `default smith ${assigned}`
          : "Smith unavailable"}{" "}
        · {entry.status.replaceAll("_", " ")}
      </p>
      {card.smith.reason && <p class="af-wb-note">{card.smith.reason}</p>}
      {card.note && <p class="af-wb-note">{card.note}</p>}
      {card.eligibility && (
        <div
          class={`af-wb-admission ${fresh && card.eligibility.may === true ? "may-start" : "waits"}`}
        >
          <strong>
            {!fresh || card.eligibility.may === null
              ? "Eligibility unavailable"
              : card.eligibility.may
                ? "May start"
                : "Waits"}
          </strong>
          <p>
            {fresh
              ? card.eligibility.reason
              : "This observation is out of date. Refresh to check eligibility again."}
          </p>
        </div>
      )}
      {entry.state === "running" &&
        (card.session ? (
          <>
            <a
              class="af-wb-session"
              href={desktopHref({
                projectId: page.projectId,
                destination: "sessions",
                selection: { kind: "session", id: card.session.id },
              })}
            >
              {card.session.provider ?? "Provider unavailable"} ·{" "}
              {Number.isFinite(started)
                ? `${Math.max(0, Math.floor((now - started) / 60000))} min observed`
                : "Start time unavailable"}
            </a>
            <p class="af-wb-path">
              {card.session.worktree ?? "Worktree unavailable"}
            </p>
          </>
        ) : (
          <p class="af-wb-note">No linked session was observed.</p>
        ))}
      {entry.state === "review" && (
        <p class="af-wb-note">
          Inspect the bead for recorded PR links and gate evidence. A passing
          gate is not established by this queue label.
        </p>
      )}
      {entry.state === "halted" && (
        <p class="af-wb-note">
          The queue records Halted. Inspect the last worklog and gate evidence
          before queuing again; repair counts are unavailable in this read.
        </p>
      )}
      {entry.state === "paused" && card.moves.includes("resume") && (
        <p class="af-wb-note">
          Resume returns this bead to {COLUMN_LABELS[entry.resume ?? "queued"]}.
        </p>
      )}
      {card.moves.filter((action) => action !== "reassign").length > 0 && (
        <div class="af-wb-moves">
          {card.moves
            .filter((action) => action !== "reassign")
            .map((action) => (
              <Button
                key={action}
                disabled={blocked}
                aria-disabled={held}
                aria-label={`${labels[action]} ${entry.beadId}`}
                onClick={() => onMove(action)}
              >
                {labels[action]}
              </Button>
            ))}
        </div>
      )}
      {card.moves.includes("reassign") && (
        <div class="af-wb-reassign">
          <label>
            Reassign smith
            <select
              aria-label={`Smith for ${entry.beadId}`}
              value={chosen}
              disabled={blocked || choices.length === 0}
              onChange={(e) => setSmith(e.currentTarget.value)}
            >
              <option value="">Choose a smith</option>
              {choices.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </label>
          <Button
            disabled={blocked || !chosen}
            aria-disabled={held || !chosen}
            aria-label={`Reassign ${entry.beadId}`}
            onClick={() => onMove("reassign", chosen)}
          >
            Apply
          </Button>
        </div>
      )}
      <a class="af-wb-open" href={beadHref(page.projectId, entry.beadId, true)}>
        Open bead
      </a>
    </article>
  );
}
