import { Fragment, h } from "preact";
import { useMemo } from "preact/hooks";
import type { BeadsIssue, BeadsPayload } from "../../../types/beads";
import {
  issueIdCopyControlHtml,
  toggleExpandedState,
} from "../issue-detail.mjs";
import {
  applyInitiativeFilter,
  formatIssueDate,
  issuesInProgress,
  listEpics,
  sortByUpdatedDesc,
} from "../issues-selection.mjs";
import { IssueDetailPanel } from "./IssueDetailPanel";

const STATUS_COLOR: Record<string, string> = {
  open: "#3dff9c",
  in_progress: "#ffe94d",
  closed: "#aeb8ce",
  blocked: "#ff4757",
};

const STATUS_CLOSED_CHECK = "#34f097";

const TYPE_ICON: Record<string, string> = {
  epic: "⚡",
  feature: "✨",
  task: "📄",
  bug: "🐛",
  chore: "🔧",
};

const PRIORITY_COLOR: Record<string, string> = {
  critical: "#ff3838",
  high: "#ffb020",
  medium: "#6ec6ff",
  low: "#8aa4c8",
};

const ISSUE_TABLE_COLSPAN = 8;

const EXPANDABLE_ISSUE_HEAD_INNER =
  '<tr><th>ID</th><th>Title</th><th class="type-col">Type</th><th>Status</th><th>Priority</th><th>Repo</th><th class="date-col">Created</th><th class="date-col">Updated</th></tr>';

function esc(str: unknown): string {
  return String(str != null ? str : "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function statusBadgeHtml(status: unknown): string {
  const s = String(status != null ? status : "");
  if (s === "closed") {
    const fg = STATUS_COLOR.closed;
    return (
      '<span class="badge badge-status-closed" style="display:inline-flex;align-items:center;gap:0.32em;background:' +
      fg +
      "26;color:" +
      fg +
      ";border:1px solid " +
      fg +
      '55"><span style="color:' +
      STATUS_CLOSED_CHECK +
      ';font-weight:800;line-height:1;font-size:1.05em" aria-hidden="true">\u2713</span><span>closed</span></span>'
    );
  }
  const color = STATUS_COLOR[s] || "#8aa4c8";
  return (
    '<span class="badge" style="background:' +
    color +
    "20;color:" +
    color +
    ";border:1px solid " +
    color +
    '40">' +
    esc(s) +
    "</span>"
  );
}

function priorityBadgeHtml(priority: unknown): string {
  if (!priority) return "";
  const color = PRIORITY_COLOR[String(priority)] || "#8aa4c8";
  return (
    '<span class="badge" style="color:' +
    color +
    '">' +
    String(priority) +
    "</span>"
  );
}

function typeCellHtml(type: unknown): string {
  const icon = TYPE_ICON[String(type)] || "";
  const label = esc(String(type || ""));
  if (!label && !icon) return "—";
  return (
    '<span class="type-pill">' +
    (icon
      ? '<span class="type-icon" aria-hidden="true">' + icon + "</span>"
      : "") +
    (label ? '<span class="type-label">' + label + "</span>" : "") +
    "</span>"
  );
}

function activeBlockerIdsByIssue(issues: BeadsIssue[], deps: BeadsPayload["deps"]): Map<string, string[]> {
  const byId = new Map<string, BeadsIssue>();
  for (const issue of issues) byId.set(issue.id, issue);
  const out = new Map<string, string[]>();
  for (const dep of deps || []) {
    if (dep.type !== "blocks" && dep.type !== "requires") continue;
    const blocker = byId.get(dep.to);
    if (!blocker || blocker.status === "closed") continue;
    const list = out.get(dep.from) || [];
    if (list.indexOf(dep.to) === -1) list.push(dep.to);
    out.set(dep.from, list);
  }
  return out;
}

function InitiativeSelect({
  issues,
  initiativeFilter,
  onInitiativeChange,
}: {
  issues: BeadsIssue[];
  initiativeFilter: string;
  onInitiativeChange: (v: string) => void;
}) {
  const epics = useMemo(() => listEpics(issues), [issues]);
  return (
    <label
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "0.45rem",
        color: "var(--text-muted)",
        fontSize: "0.85rem",
      }}
    >
      <span>Initiative</span>
      <select
        id="filter-initiative"
        value={initiativeFilter}
        onChange={(e) =>
          onInitiativeChange((e.currentTarget as HTMLSelectElement).value)
        }
        style={{
          padding: "0.4rem 0.75rem",
          background: "var(--surface-2)",
          border: "1px solid var(--border)",
          color: "var(--text)",
          borderRadius: "6px",
          fontSize: "0.875rem",
          maxWidth: "22rem",
        }}
      >
        <option value="all">All initiatives</option>
        {epics.map((e: BeadsIssue) => {
          const label = e.title ? e.title + "  (" + e.id + ")" : e.id;
          return (
            <option key={e.id} value={e.id}>
              {label}
            </option>
          );
        })}
      </select>
    </label>
  );
}

function HtmlCell({ html }: { html: string }) {
  return <span dangerouslySetInnerHTML={{ __html: html }} />;
}

export type IssuesViewsIslandProps = {
  variant: "dashboard" | "list";
  payload: BeadsPayload;
  initiativeFilter: string;
  onInitiativeChange: (v: string) => void;
  expandedIssueId: string | null;
  onExpandedChange: (id: string | null) => void;
  listStatusFilter: string;
  listSearchQuery: string;
  onListStatusChange: (v: string) => void;
  onListSearchChange: (v: string) => void;
};

function ExpandableIssueTable({
  issues,
  max,
  expandedIssueId,
  onRowActivate,
  onCloseDetail,
  payload,
}: {
  issues: BeadsIssue[];
  max: number;
  expandedIssueId: string | null;
  onRowActivate: (id: string) => void;
  onCloseDetail: () => void;
  payload: BeadsPayload;
}) {
  const slice = issues.slice(0, max);
  const blockerIdsByIssue = useMemo(
    () => activeBlockerIdsByIssue(payload.issues || [], payload.deps || []),
    [payload.issues, payload.deps],
  );
  if (slice.length === 0) {
    return <p style={{ color: "var(--text-muted)" }}>None.</p>;
  }
  return (
    <table className="issue-table issue-table-expandable">
      <thead
        dangerouslySetInnerHTML={{ __html: EXPANDABLE_ISSUE_HEAD_INNER }}
      />
      <tbody>
        {slice.map((i) => {
          const isOpen = expandedIssueId === i.id;
          const blockerIds = blockerIdsByIssue.get(i.id) || [];
          return (
            <Fragment key={i.id}>
              <tr
                className={"issue-summary-row" + (isOpen ? " is-expanded" : "")}
                data-issue-id={i.id}
                role="button"
                tabIndex={0}
                aria-expanded={isOpen ? "true" : "false"}
                onClick={(e) => {
                  if ((e.target as HTMLElement).closest(".issue-id-copy"))
                    return;
                  onRowActivate(i.id);
                }}
                onKeyDown={(e) => {
                  if (e.key !== "Enter" && e.key !== " ") return;
                  if ((e.target as HTMLElement).closest(".issue-id-copy"))
                    return;
                  e.preventDefault();
                  onRowActivate(i.id);
                }}
              >
                <td>
                  <HtmlCell html={issueIdCopyControlHtml(i.id)} />
                </td>
                <td>
                  {esc(i.title)}
                  {blockerIds.length > 0 ? (
                    <div style={{ color: "var(--text-muted)", fontSize: "0.78rem", marginTop: "0.2rem" }}>
                      Blocked by {blockerIds.join(", ")}
                    </div>
                  ) : null}
                </td>
                <td className="type-col">
                  <HtmlCell html={typeCellHtml(i.type)} />
                </td>
                <td>
                  <HtmlCell html={statusBadgeHtml(i.status)} />
                </td>
                <td>
                  <HtmlCell html={priorityBadgeHtml(i.priority)} />
                </td>
                <td>{esc(i.repo || "—")}</td>
                <td className="date-col">
                  <HtmlCell html={formatIssueDate(i.createdAt)} />
                </td>
                <td className="date-col">
                  <HtmlCell html={formatIssueDate(i.updatedAt)} />
                </td>
              </tr>
              <tr className="issue-detail-gap">
                <td colSpan={ISSUE_TABLE_COLSPAN}>
                  <div
                    className={"issue-detail-anim" + (isOpen ? " is-open" : "")}
                  >
                    <div className="issue-detail-anim-inner">
                      {isOpen ? (
                        <IssueDetailPanel
                          issue={i}
                          ctx={{
                            comments: payload.comments,
                            deps: payload.deps,
                          }}
                          onClose={onCloseDetail}
                        />
                      ) : null}
                    </div>
                  </div>
                </td>
              </tr>
            </Fragment>
          );
        })}
      </tbody>
    </table>
  );
}

export function IssuesViewsIsland({
  variant,
  payload,
  initiativeFilter,
  onInitiativeChange,
  expandedIssueId,
  onExpandedChange,
  listStatusFilter,
  listSearchQuery,
  onListStatusChange,
  onListSearchChange,
}: IssuesViewsIslandProps) {
  const issues = payload.issues || [];
  const derived = payload.derived;

  function onRowActivate(id: string) {
    onExpandedChange(toggleExpandedState(expandedIssueId, id));
  }

  if (variant === "dashboard") {
    const openAllUnfiltered = (derived.byStatus || {}).open || [];
    const inProgressUnfiltered = (derived.byStatus || {}).in_progress || [];
    const readyUnfiltered = derived.ready || [];
    const blockedUnfiltered = derived.blocked || [];
    const closedUnfiltered = (derived.byStatus || {}).closed || [];

    const openAll = applyInitiativeFilter(openAllUnfiltered, initiativeFilter);
    const inProgressAll = applyInitiativeFilter(
      issuesInProgress(issues),
      initiativeFilter,
    ).sort(sortByUpdatedDesc);
    const readyAll = applyInitiativeFilter(readyUnfiltered, initiativeFilter);
    const blockedAll = applyInitiativeFilter(
      blockedUnfiltered,
      initiativeFilter,
    );
    const closedAll = applyInitiativeFilter(closedUnfiltered, initiativeFilter)
      .slice()
      .sort(sortByUpdatedDesc);

    const ready = readyAll.slice(0, 15);
    const inProgressIssues = inProgressAll.slice(0, 25);
    const blockedList = blockedAll.slice(0, 15);
    const closedRecent = closedAll.slice(0, 25);

    const open = openAll.length;
    const inProgressCount =
      initiativeFilter === "all"
        ? inProgressUnfiltered.length
        : inProgressAll.length;
    const closed = closedAll.length;
    const blocked = blockedAll.length;

    return (
      <Fragment>
        <div className="filter-row">
          <InitiativeSelect
            issues={issues}
            initiativeFilter={initiativeFilter}
            onInitiativeChange={onInitiativeChange}
          />
        </div>
        <div className="stat-row">
          <div className="stat-card">
            <div className="stat-num" style={{ color: "#3dff9c" }}>
              {open}
            </div>
            <div className="stat-label">Open</div>
          </div>
          <div className="stat-card">
            <div className="stat-num" style={{ color: "#ffe94d" }}>
              {inProgressCount}
            </div>
            <div className="stat-label">In Progress</div>
          </div>
          <div className="stat-card">
            <div className="stat-num" style={{ color: "#ff4757" }}>
              {blocked}
            </div>
            <div className="stat-label">Blocked</div>
          </div>
          <div className="stat-card">
            <div className="stat-num" style={{ color: "#aeb8ce" }}>
              {closed}
            </div>
            <div className="stat-label">Closed</div>
          </div>
        </div>
        <p
          style={{
            color: "var(--text-muted)",
            fontSize: "0.85rem",
            margin: "0 0 1.25rem",
          }}
        >
          Beads is the issue graph tracked with{" "}
          <code style={{ fontSize: "0.9em" }}>bd</code> (epics, tasks,
          dependencies). This dashboard shows a built snapshot: status counts
          and lists of ready, in-progress, blocked, and recently closed work.
        </p>
        <h3>In Progress ({inProgressAll.length})</h3>
        <ExpandableIssueTable
          issues={inProgressIssues}
          max={25}
          expandedIssueId={expandedIssueId}
          onRowActivate={onRowActivate}
          onCloseDetail={() => onExpandedChange(null)}
          payload={payload}
        />
        <h3>Ready to Work ({readyAll.length})</h3>
        <ExpandableIssueTable
          issues={ready}
          max={15}
          expandedIssueId={expandedIssueId}
          onRowActivate={onRowActivate}
          onCloseDetail={() => onExpandedChange(null)}
          payload={payload}
        />
        {blockedAll.length > 0 ? (
          <Fragment>
            <h3>Blocked ({blockedAll.length})</h3>
            <ExpandableIssueTable
              issues={blockedList}
              max={15}
              expandedIssueId={expandedIssueId}
              onRowActivate={onRowActivate}
              onCloseDetail={() => onExpandedChange(null)}
              payload={payload}
            />
          </Fragment>
        ) : null}
        <h3>Recently closed ({closedAll.length})</h3>
        <ExpandableIssueTable
          issues={closedRecent}
          max={25}
          expandedIssueId={expandedIssueId}
          onRowActivate={onRowActivate}
          onCloseDetail={() => onExpandedChange(null)}
          payload={payload}
        />
      </Fragment>
    );
  }

  const search = listSearchQuery.toLowerCase();
  const filteredIssues = applyInitiativeFilter(issues, initiativeFilter).filter(
    (i: BeadsIssue) => {
      const matchStatus =
        listStatusFilter === "all" || i.status === listStatusFilter;
      const matchSearch =
        !search ||
        i.title.toLowerCase().indexOf(search) !== -1 ||
        i.id.toLowerCase().indexOf(search) !== -1;
      return matchStatus && matchSearch;
    },
  );

  return (
    <Fragment>
      <div className="filter-row" style={{ flexWrap: "wrap" }}>
        <input
          id="search-input"
          type="text"
          placeholder="Search..."
          value={listSearchQuery}
          onInput={(e) =>
            onListSearchChange((e.currentTarget as HTMLInputElement).value)
          }
          style={{
            padding: "0.4rem 0.75rem",
            background: "var(--surface-2)",
            border: "1px solid var(--border)",
            color: "var(--text)",
            borderRadius: "6px",
            fontSize: "0.875rem",
          }}
        />
        <select
          id="filter-status"
          value={listStatusFilter}
          onChange={(e) =>
            onListStatusChange((e.currentTarget as HTMLSelectElement).value)
          }
          style={{
            padding: "0.4rem 0.75rem",
            background: "var(--surface-2)",
            border: "1px solid var(--border)",
            color: "var(--text)",
            borderRadius: "6px",
            fontSize: "0.875rem",
          }}
        >
          {(["all", "open", "in_progress", "blocked", "closed"] as const).map(
            (s) => (
              <option key={s} value={s}>
                {s === "all" ? "All statuses" : s}
              </option>
            ),
          )}
        </select>
        <InitiativeSelect
          issues={issues}
          initiativeFilter={initiativeFilter}
          onInitiativeChange={onInitiativeChange}
        />
      </div>
      <p
        style={{
          color: "var(--text-muted)",
          fontSize: "0.85rem",
          marginBottom: "0.75rem",
        }}
      >
        {filteredIssues.length} issues
      </p>
      <ExpandableIssueTable
        issues={filteredIssues.slice(0, 100)}
        max={100}
        expandedIssueId={expandedIssueId}
        onRowActivate={onRowActivate}
        onCloseDetail={() => onExpandedChange(null)}
        payload={payload}
      />
    </Fragment>
  );
}
