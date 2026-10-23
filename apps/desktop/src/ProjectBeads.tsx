import { useState } from "preact/hooks";
import { Button } from "../../../docs/js/ds/Button";
import { EmptyState } from "../../../docs/js/ds/EmptyState";
import { Icon, type IconName } from "../../../docs/js/ds/Icon";
import type { SessionSummary } from "../../../types/hearth";
import type {
  ProjectBead,
  ProjectBeadsPage,
} from "../../../types/project-beads";
import {
  BEAD_VIEWS,
  type BeadFilters,
  beadAncestors,
  beadGroups,
  epicProgress,
  filterBeads,
  newBeadFilters,
} from "./beads-model";
import { KeeperMarkdown } from "./KeeperMarkdown";
import { desktopHref } from "./navigation";
import "./beads.css";

export const beadHref = (projectId: string, id: string, full = false) =>
  `${desktopHref({ projectId, destination: "beads", selection: { kind: "bead", id } })}${full ? "&view=full" : ""}`;
const status = (value: string) => value.replaceAll("_", " ");
const glyph: Record<ProjectBead["type"], IconName> = {
  epic: "flow-arrow",
  feature: "squares-four",
  task: "list-checks",
  bug: "warning-circle",
  chore: "gear",
};
export function ProjectBeads({
  projectId,
  page,
  error,
  loading,
  reload,
  selectedId,
  onSelect,
  onOpen,
}: {
  projectId: string;
  page: ProjectBeadsPage | null;
  error: string | null;
  loading: boolean;
  reload(): void;
  selectedId: string | null;
  onSelect(id: string): void;
  onOpen(id: string): void;
}) {
  const [filters, setFilters] = useState(newBeadFilters),
    [copy, setCopy] = useState("");
  const rows = page?.beads ?? [],
    filtered = filterBeads(rows, filters);
  const update = (patch: Partial<BeadFilters>) =>
    setFilters({ ...filters, ...patch });
  const choices = (
    key: keyof Pick<ProjectBead, "type" | "status" | "queue" | "assignee">,
  ) =>
    [
      ...new Set(
        rows
          .map((bead) => bead[key])
          .filter((value): value is string => value !== null),
      ),
    ].sort();
  const select = (
    label: string,
    key: keyof Pick<
      BeadFilters,
      "type" | "priority" | "status" | "queue" | "label" | "epic" | "assignee"
    >,
    options: readonly string[],
  ) => (
    <label>
      {label}
      <select
        aria-label={`Filter beads by ${label.toLowerCase()}`}
        value={filters[key]}
        onChange={(event) => update({ [key]: event.currentTarget.value })}
      >
        <option value="">All</option>
        {options.map((value) => (
          <option key={value} value={value}>
            {key === "priority" ? `P${value}` : status(value)}
          </option>
        ))}
      </select>
    </label>
  );
  return (
    <section class="af-beads" aria-label="Project beads" aria-busy={loading}>
      <header class="af-beads-heading">
        <div>
          <p class="af-beads-eyebrow">Live tracker · project scope</p>
          <h1>Beads</h1>
          <p>Ready means open, unblocked and unclaimed.</p>
        </div>
        <Button onClick={reload} disabled={loading}>
          Refresh beads
        </Button>
      </header>
      <div class="af-beads-tabs" role="tablist" aria-label="Bead views">
        {BEAD_VIEWS.map(([id, label]) => (
          <button
            class="af-btn af-btn-secondary"
            type="button"
            role="tab"
            aria-selected={filters.view === id}
            key={id}
            onClick={() => update({ view: id })}
          >
            {label}
            <span>
              {filterBeads(rows, { ...newBeadFilters(), view: id }).length}
            </span>
          </button>
        ))}
      </div>
      <div class="af-beads-toolbar">
        <label class="af-beads-search">
          Search
          <input
            type="search"
            aria-label="Search beads by id or title"
            value={filters.query}
            onInput={(event) => update({ query: event.currentTarget.value })}
            placeholder="Id or title"
          />
        </label>
        {select("Type", "type", choices("type"))}
        {select("Priority", "priority", ["0", "1", "2", "3", "4"])}
        {select("Status", "status", choices("status"))}
        {select("Queue state", "queue", choices("queue"))}
        {select(
          "Label",
          "label",
          [...new Set(rows.flatMap((bead) => bead.labels))].sort(),
        )}
        {select(
          "Epic",
          "epic",
          rows.filter((bead) => bead.type === "epic").map((bead) => bead.id),
        )}
        {select("Assignee", "assignee", choices("assignee"))}
        <label>
          Group by
          <select
            aria-label="Group beads by"
            value={filters.group}
            onChange={(event) => {
              const value = event.currentTarget.value;
              if (value === "none" || value === "epic" || value === "status")
                update({ group: value });
            }}
          >
            <option value="none">None</option>
            <option value="epic">Epic</option>
            <option value="status">Status</option>
          </select>
        </label>
        <Button onClick={() => setFilters(newBeadFilters())}>
          Reset views and filters
        </Button>
      </div>
      {error && <p role="alert">{error}</p>}
      {loading && !page && <p role="status">Loading live project beads…</p>}
      {page?.problems.map((problem) => (
        <p class="af-beads-warning" key={problem}>
          {problem}
        </p>
      ))}
      {page && (
        <p class="af-beads-meta">
          {filtered.length} of {rows.length} scoped beads · Read{" "}
          <time dateTime={page.asOf}>
            {new Date(page.asOf).toLocaleTimeString()}
          </time>
          {!page.complete && " · Other workspace or epic data is unavailable"}
        </p>
      )}
      {copy && <p role="status">{copy}</p>}
      {page && rows.length === 0 ? (
        <EmptyState
          title="No beads in this project"
          hint="A bead must belong to a saved epic and carry the project label."
        />
      ) : page && filtered.length === 0 ? (
        <EmptyState
          title={
            rows.length && filters.query
              ? "No beads match these filters"
              : `No ${BEAD_VIEWS.find(([id]) => id === filters.view)?.[1].toLowerCase()} beads`
          }
          hint="Try another view or reset the filters."
        />
      ) : filters.view === "epics" ? (
        <div class="af-beads-epics">
          {filtered.map((bead) => {
            const progress = epicProgress(rows, bead.id);
            return (
              <article key={bead.id} class="af-beads-epic">
                <div>
                  <code>{bead.id}</code>
                  <span class={`af-bead-status af-bead-status-${bead.status}`}>
                    {status(bead.status)}
                  </span>
                </div>
                <h2>
                  <a href={beadHref(projectId, bead.id, true)}>{bead.title}</a>
                </h2>
                <p>
                  {progress.closed} of {progress.total} children closed
                </p>
                <progress
                  aria-label={`Progress for ${bead.id}`}
                  value={progress.closed}
                  max={Math.max(1, progress.total)}
                />
                <p>
                  {progress.states
                    .map((item) => `${item.count} ${status(item.status)}`)
                    .join(" · ")}
                </p>
                <p>
                  {progress.blocked} blocked children · Due{" "}
                  {bead.due ?? "not reported"}
                </p>
                <Button onClick={() => onSelect(bead.id)}>Inspect epic</Button>
                <Button
                  onClick={() => {
                    update({ view: "all", epic: bead.id });
                    onSelect(bead.id);
                  }}
                >
                  View child beads
                </Button>
              </article>
            );
          })}
        </div>
      ) : (
        beadGroups(filtered, filters.group, rows).map((group) => (
          <div key={group.title} class="af-beads-group">
            {filters.group !== "none" && (
              <h2>
                {status(group.title)} · {group.beads.length}
              </h2>
            )}
            <div class="af-beads-table-wrap">
              <table aria-label={`${group.title} table`}>
                <thead>
                  <tr>
                    {[
                      "Id",
                      "Title",
                      "Type",
                      "Status",
                      "Priority",
                      "Queue state",
                      "Smith",
                      "Updated",
                    ].map((label) => (
                      <th scope="col" key={label}>
                        {label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {group.beads.map((bead) => (
                    <tr key={bead.id} aria-selected={selectedId === bead.id}>
                      <td>
                        <button
                          class="af-bead-id"
                          type="button"
                          aria-label={`Copy bead ${bead.id}`}
                          onClick={() => {
                            void navigator.clipboard.writeText(bead.id).then(
                              () => setCopy(`Copied ${bead.id}.`),
                              () =>
                                setCopy(
                                  `Copy unavailable. Select the bead id: ${bead.id}`,
                                ),
                            );
                          }}
                        >
                          {bead.id}
                        </button>
                      </td>
                      <td>
                        <button
                          class="af-bead-title"
                          type="button"
                          aria-label={`Inspect ${bead.id}: ${bead.title}`}
                          onClick={() => onSelect(bead.id)}
                          onDblClick={() => onOpen(bead.id)}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") {
                              event.preventDefault();
                              onOpen(bead.id);
                            }
                          }}
                        >
                          {bead.title}
                        </button>
                        {bead.blocked && (
                          <small>
                            Blocked
                            {bead.blockers.length
                              ? ` by ${bead.blockers.join(", ")}`
                              : ""}
                            {bead.unavailableBlockers > 0
                              ? ` · ${bead.unavailableBlockers} prerequisite outside this project or unavailable`
                              : ""}
                          </small>
                        )}
                      </td>
                      <td>
                        <Icon name={glyph[bead.type]} />
                        <span>{bead.type}</span>
                      </td>
                      <td>
                        <span
                          class={`af-bead-status af-bead-status-${bead.status}`}
                        >
                          {status(bead.status)}
                        </span>
                      </td>
                      <td
                        class={`af-bead-priority af-bead-priority-${bead.priority}`}
                      >
                        {bead.priority === null ? "—" : `P${bead.priority}`}
                      </td>
                      <td>{bead.queue ? status(bead.queue) : "—"}</td>
                      <td>{bead.smith ?? "—"}</td>
                      <td>
                        <time dateTime={bead.updatedAt}>
                          {bead.updatedAt
                            ? new Date(bead.updatedAt).toLocaleDateString()
                            : "Not reported"}
                        </time>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ))
      )}
      <p class="af-beads-meta">
        Select a title to inspect. Enter or double-click opens the bead
        full-width. A dash means not reported.
      </p>
    </section>
  );
}

export function BeadPanel({
  projectId,
  id,
  page,
  sessions = [],
  onAskKeeper,
  onStart,
}: {
  projectId: string;
  id: string;
  page: ProjectBeadsPage | null;
  sessions?: readonly SessionSummary[];
  onAskKeeper(): void;
  onStart?: ((id: string) => void) | undefined;
}) {
  const [tab, setTab] = useState("Details"),
    bead = page?.beads.find((item) => item.id === id);
  if (!page) return <p role="status">Loading the selected bead…</p>;
  if (!bead)
    return (
      <EmptyState
        title="Bead unavailable"
        hint="This id is absent from the current project scope. Refresh the bead list to check again."
      />
    );
  const parents = beadAncestors(bead, page.beads),
    edges = page.dependencies.filter(
      (edge) => edge.from === id || edge.to === id,
    ),
    children = page.beads.filter((item) => item.parent === id);
  return (
    <section class="af-bead-panel" aria-label={`Bead ${id}`}>
      <p class="af-beads-eyebrow">
        {parents
          .slice()
          .reverse()
          .map((parent) => (
            <a key={parent} href={beadHref(projectId, parent, true)}>
              {parent} /{" "}
            </a>
          ))}
        <code>{id}</code>
      </p>
      <h2>{bead.title}</h2>
      <p>
        <span class={`af-bead-status af-bead-status-${bead.status}`}>
          {status(bead.status)}
        </span>{" "}
        ·{" "}
        {bead.priority === null ? "Priority not reported" : `P${bead.priority}`}{" "}
        · {bead.type}
      </p>
      <div class="af-beads-actions">
        <Button href={beadHref(projectId, id, true)}>Open full-width</Button>
        <Button onClick={() => onStart?.(id)} disabled={!onStart}>
          Start session
        </Button>
        <Button onClick={onAskKeeper}>Ask the Keeper</Button>
      </div>
      <div
        class="af-beads-tabs"
        role="tablist"
        aria-label="Bead inspector tabs"
      >
        {[
          "Details",
          "Dependencies",
          "Comments",
          "Sessions",
          "Files",
          "Activity",
        ].map((name) => (
          <button
            class="af-btn af-btn-secondary"
            role="tab"
            type="button"
            aria-selected={tab === name}
            onClick={() => setTab(name)}
            key={name}
          >
            {name}
          </button>
        ))}
      </div>
      <div role="tabpanel" aria-label={`${tab} for ${id}`}>
        {tab === "Details" ? (
          <>
            <h3>Acceptance criteria</h3>
            {bead.acceptanceCriteria ? (
              <KeeperMarkdown text={bead.acceptanceCriteria} />
            ) : (
              <p>Acceptance criteria are not reported.</p>
            )}
            <h3>Description</h3>
            {bead.description ? (
              <KeeperMarkdown text={bead.description} />
            ) : (
              <p>No description reported.</p>
            )}
            <dl>
              <dt>Labels</dt>
              <dd>{bead.labels.join(", ") || "None reported"}</dd>
              <dt>Assignee</dt>
              <dd>{bead.assignee ?? "Unclaimed"}</dd>
              <dt>Owner</dt>
              <dd>{bead.owner ?? "Not reported"}</dd>
              <dt>Estimate / time spent</dt>
              <dd>
                {bead.estimate ?? "—"} / {bead.spent ?? "—"} minutes
              </dd>
              <dt>Due</dt>
              <dd>{bead.due ?? "Not reported"}</dd>
              <dt>Queue state</dt>
              <dd>{bead.queue ? status(bead.queue) : "Not reported"}</dd>
              <dt>Smith</dt>
              <dd>{bead.smith ?? "Not reported"}</dd>
            </dl>
            {children.length > 0 && (
              <>
                <h3>Child beads</h3>
                <ul>
                  {children.map((child) => (
                    <li key={child.id}>
                      <a href={beadHref(projectId, child.id, true)}>
                        {child.id} · {child.title}
                      </a>{" "}
                      · {status(child.status)}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </>
        ) : tab === "Dependencies" ? (
          <>
            <p>
              Arrows point from a dependent bead to its prerequisite. Parent
              hierarchy is separate.
            </p>
            {edges.length === 0 && (
              <p>No dependencies between visible project beads.</p>
            )}
            <div
              class="af-bead-graph"
              role="img"
              aria-label={`Dependency graph for ${id}`}
            >
              {edges.slice(0, 20).map((edge) => (
                <div
                  class="af-bead-graph-edge"
                  key={`${edge.from}:${edge.to}:${edge.type}`}
                >
                  <a href={beadHref(projectId, edge.from, true)}>
                    {edge.from}
                    <small>
                      {status(
                        page.beads.find((item) => item.id === edge.from)
                          ?.status ?? "unknown",
                      )}
                    </small>
                  </a>
                  <span
                    role="img"
                    aria-label={
                      edge.type === "relates" ? "related to" : "depends on"
                    }
                  >
                    {edge.type === "relates" ? "↔" : "→"}
                  </span>
                  <a href={beadHref(projectId, edge.to, true)}>
                    {edge.to}
                    <small>
                      {status(
                        page.beads.find((item) => item.id === edge.to)
                          ?.status ?? "unknown",
                      )}
                    </small>
                  </a>
                </div>
              ))}
            </div>
            {edges.length > 20 && (
              <p>
                {edges.length - 20} additional connections are listed below.
              </p>
            )}
            <h3>Blocked by</h3>
            <ul>
              {edges
                .filter((edge) => edge.from === id && edge.type !== "relates")
                .map((edge) => (
                  <li key={edge.to}>
                    <a href={beadHref(projectId, edge.to, true)}>{edge.to}</a> ·{" "}
                    {status(
                      page.beads.find((item) => item.id === edge.to)?.status ??
                        "unknown",
                    )}
                  </li>
                ))}
            </ul>
            {bead.unavailableBlockers > 0 && (
              <p>
                {bead.unavailableBlockers} prerequisite outside this project or
                unavailable. Ready remains unavailable while it is unresolved.
              </p>
            )}
            <h3>Blocks</h3>
            <ul>
              {edges
                .filter((edge) => edge.to === id && edge.type !== "relates")
                .map((edge) => (
                  <li key={edge.from}>
                    <a href={beadHref(projectId, edge.from, true)}>
                      {edge.from}
                    </a>
                  </li>
                ))}
            </ul>
          </>
        ) : tab === "Comments" ? (
          <>
            {!bead.commentsComplete && (
              <p role="status">
                Embedded tracker comments may be incomplete; this read does not
                claim a full comment history.
              </p>
            )}
            {bead.comments.length === 0 ? (
              <p>No comments in this tracker read.</p>
            ) : (
              bead.comments.map((comment, index) => (
                <article
                  class="af-bead-comment"
                  key={`${comment.createdAt}:${index}`}
                >
                  <p>
                    <span>
                      {/^(worklog|ac|design|deps|review):/.exec(
                        comment.body,
                      )?.[1] ?? "comment"}
                    </span>{" "}
                    · {comment.author || "Author not reported"} ·{" "}
                    <time dateTime={comment.createdAt}>
                      {comment.createdAt || "Time not reported"}
                    </time>
                  </p>
                  <KeeperMarkdown text={comment.body} />
                </article>
              ))
            )}
          </>
        ) : tab === "Sessions" ? (
          sessions.filter((session) => session.beadId === id).length === 0 ? (
            <p>No bead-bound sessions in the current project observations.</p>
          ) : (
            <ul>
              {sessions
                .filter((session) => session.beadId === id)
                .map((session) => (
                  <li key={session.sessionId}>
                    <a
                      href={desktopHref({
                        projectId,
                        destination: "sessions",
                        selection: { kind: "session", id: session.sessionId },
                      })}
                    >
                      {session.sessionId}
                    </a>{" "}
                    · {session.executor?.provider ?? "Provider not reported"}
                  </li>
                ))}
            </ul>
          )
        ) : tab === "Files" ? (
          <p>
            File maps and active reservations are not reported by this bead
            read. Inspect the current reservation view before starting
            overlapping work.
          </p>
        ) : (
          <p>
            Activity details are not reported by this bead read. Comments and
            linked sessions retain their own provenance.
          </p>
        )}
      </div>
    </section>
  );
}
