import { Fragment, type JSX } from "preact";
import { useMemo } from "preact/hooks";
import type {
  BeadsIssue,
  BeadsPayload,
  EpicFlowData,
} from "../../../types/beads";
import { Card } from "../ds/Card";
import { EmptyState } from "../ds/EmptyState";
import { Input, Select } from "../ds/Field";
import { Icon } from "../ds/Icon";
import { StatCard } from "../ds/StatCard";
import { Table } from "../ds/Table";
import { Tag } from "../ds/Tag";
import { toggleExpandedState } from "../issue-detail.mjs";
import {
  priorityTone,
  statusLabel,
  statusTone,
  typeIcon,
} from "../issue-presentation";
import { formatIssueDate } from "../issues-selection.mjs";
import { CopyIdButton } from "./CopyIdButton";
import { InitiativeSelect } from "./InitiativeSelect";
import { IssueDetailPanel } from "./IssueDetailPanel";
import {
  activeBlockerIdsByIssue,
  dashboardSections,
  filterListIssues,
  LIST_ROW_CAP,
} from "./issues-views-model";

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

const STATUS_FILTERS = [
  "all",
  "open",
  "in_progress",
  "blocked",
  "closed",
] as const;

function IssueTable({
  issues,
  payload,
  expandedIssueId,
  onRowActivate,
  onCloseDetail,
  label,
}: {
  issues: BeadsIssue[];
  payload: BeadsPayload;
  expandedIssueId: string | null;
  onRowActivate: (id: string) => void;
  onCloseDetail: () => void;
  label: string;
}): JSX.Element {
  const blockersByIssue = useMemo(
    () => activeBlockerIdsByIssue(payload.issues ?? [], payload.deps ?? []),
    [payload.issues, payload.deps],
  );

  return (
    <Table<BeadsIssue>
      label={label}
      rows={issues}
      rowKey={(issue) => issue.id}
      empty="None."
      columns={[
        {
          key: "id",
          header: "ID",
          class: "af-col-id",
          cell: (issue) => <CopyIdButton issueId={issue.id} />,
        },
        {
          key: "title",
          header: "Title",
          cell: (issue) => {
            const blockers = blockersByIssue.get(issue.id) ?? [];
            return (
              <>
                <span class="af-issue-title">{issue.title}</span>
                {blockers.length > 0 ? (
                  <span class="af-issue-blocked">
                    Blocked by {blockers.join(", ")}
                  </span>
                ) : null}
              </>
            );
          },
        },
        {
          key: "type",
          header: "Type",
          class: "af-col-type",
          cell: (issue) => (
            <span class="af-type">
              <Icon name={typeIcon(issue.type)} size={14} />
              {issue.type}
            </span>
          ),
        },
        {
          key: "status",
          header: "Status",
          class: "af-col-status",
          cell: (issue) => (
            <Tag tone={statusTone(issue.status)}>
              {issue.status === "closed" ? (
                <Icon name="check-circle-fill" size={12} />
              ) : null}
              {statusLabel(issue.status)}
            </Tag>
          ),
        },
        {
          key: "priority",
          header: "Priority",
          class: "af-col-priority",
          cell: (issue) =>
            issue.priority ? (
              <Tag tone={priorityTone(issue.priority)}>{issue.priority}</Tag>
            ) : (
              <span class="af-muted">—</span>
            ),
        },
        {
          key: "repo",
          header: "Repo",
          class: "af-col-repo",
          cell: (issue) => issue.repo || "—",
        },
        {
          key: "createdAt",
          header: "Created",
          class: "af-col-date",
          cell: (issue) => formatIssueDate(issue.createdAt),
        },
        {
          key: "updatedAt",
          header: "Updated",
          class: "af-col-date",
          cell: (issue) => formatIssueDate(issue.updatedAt),
        },
      ]}
      rowProps={(issue) => ({
        class: `af-issue-row${expandedIssueId === issue.id ? " is-expanded" : ""}`,
        "data-issue-id": issue.id,
        role: "button",
        tabIndex: 0,
        "aria-expanded": expandedIssueId === issue.id,
        onClick: (event: MouseEvent) => {
          // The copy button lives inside the row; clicking it must copy, not
          // toggle the row open.
          if ((event.target as HTMLElement).closest(".issue-id-copy")) return;
          onRowActivate(issue.id);
        },
        onKeyDown: (event: KeyboardEvent) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          if ((event.target as HTMLElement).closest(".issue-id-copy")) return;
          event.preventDefault();
          onRowActivate(issue.id);
        },
      })}
      rowDetail={(issue) =>
        expandedIssueId === issue.id ? (
          <IssueDetailPanel
            issue={issue}
            ctx={{ comments: payload.comments, deps: payload.deps }}
            onClose={onCloseDetail}
          />
        ) : null
      }
    />
  );
}

function EpicFlowPanel({
  initiativeFilter,
  payload,
}: {
  initiativeFilter: string;
  payload: BeadsPayload;
}): JSX.Element {
  if (initiativeFilter === "all") {
    return (
      <Card title="Epic flow" headingLevel={2}>
        <p class="af-muted">
          Select an initiative to inspect its child flow and summarized changes.
        </p>
      </Card>
    );
  }

  const flow: EpicFlowData | undefined =
    payload.derived?.epicFlowByEpic?.[initiativeFilter];

  if (!flow) {
    return (
      <Card title="Epic flow" headingLevel={2}>
        <p class="af-muted">No epic flow data for this initiative yet.</p>
      </Card>
    );
  }

  if (flow.nodes.length === 0) {
    return (
      <Card title={`Epic flow: ${flow.epicTitle}`} headingLevel={2}>
        <p class="af-muted">This epic has no child issues yet.</p>
      </Card>
    );
  }

  return (
    <Card
      kicker={flow.epicId}
      title={`Epic flow: ${flow.epicTitle}`}
      headingLevel={2}
    >
      <Table
        label={`Child issues of ${flow.epicTitle}`}
        rows={flow.nodes}
        rowKey={(node) => node.issueId}
        columns={[
          {
            key: "issueId",
            header: "ID",
            class: "af-col-id",
            cell: (node) => <CopyIdButton issueId={node.issueId} />,
          },
          { key: "title", header: "Title" },
          {
            key: "status",
            header: "Status",
            class: "af-col-status",
            cell: (node) => (
              <Tag tone={statusTone(node.status)}>
                {statusLabel(node.status)}
              </Tag>
            ),
          },
          { key: "summary", header: "Summary" },
          {
            key: "blockers",
            header: "Blocked by",
            cell: (node) =>
              node.blockers.length > 0 ? node.blockers.join(", ") : "—",
          },
        ]}
      />

      <div>
        <p class="af-section-label">Connections</p>
        {flow.edges.length > 0 ? (
          <ul class="af-flow-edges">
            {flow.edges.map((edge) => (
              <li key={`${edge.from}-${edge.to}-${edge.relation}`}>
                <code>{edge.from}</code> → <code>{edge.to}</code> (
                {edge.relation})
              </li>
            ))}
          </ul>
        ) : (
          <p class="af-muted">
            No dependency edges recorded among these issues.
          </p>
        )}
      </div>
    </Card>
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
}: IssuesViewsIslandProps): JSX.Element {
  const issues = payload.issues ?? [];

  function onRowActivate(id: string) {
    onExpandedChange(toggleExpandedState(expandedIssueId, id));
  }

  const tableProps = {
    payload,
    expandedIssueId,
    onRowActivate,
    onCloseDetail: () => onExpandedChange(null),
  };

  if (variant === "dashboard") {
    const sections = dashboardSections(payload, initiativeFilter);

    return (
      <Fragment>
        <div class="af-toolbar">
          <InitiativeSelect
            issues={issues}
            initiativeFilter={initiativeFilter}
            onInitiativeChange={onInitiativeChange}
          />
        </div>

        <div class="af-stat-row">
          <StatCard label="Open" value={sections.stats.open} tone="accent" />
          <StatCard
            label="In progress"
            value={sections.stats.inProgress}
            tone="accent"
          />
          <StatCard label="Blocked" value={sections.stats.blocked} />
          <StatCard label="Closed" value={sections.stats.closed} tone="muted" />
        </div>

        <EpicFlowPanel initiativeFilter={initiativeFilter} payload={payload} />

        <Card
          title={`In progress (${sections.inProgress.total})`}
          headingLevel={2}
        >
          <IssueTable
            issues={sections.inProgress.rows}
            label="In progress issues"
            {...tableProps}
          />
        </Card>

        <Card
          title={`Ready to work (${sections.ready.total})`}
          kicker="unblocked & unclaimed"
          headingLevel={2}
        >
          <IssueTable
            issues={sections.ready.rows}
            label="Issues ready to work"
            {...tableProps}
          />
        </Card>

        {sections.blocked.total > 0 ? (
          <Card title={`Blocked (${sections.blocked.total})`} headingLevel={2}>
            <IssueTable
              issues={sections.blocked.rows}
              label="Blocked issues"
              {...tableProps}
            />
          </Card>
        ) : null}

        <Card
          title={`Recently closed (${sections.closed.total})`}
          headingLevel={2}
        >
          <IssueTable
            issues={sections.closed.rows}
            label="Recently closed issues"
            {...tableProps}
          />
        </Card>
      </Fragment>
    );
  }

  const filtered = filterListIssues(issues, {
    search: listSearchQuery,
    status: listStatusFilter,
    initiative: initiativeFilter,
  });

  return (
    <Fragment>
      <div class="af-toolbar">
        <div class="af-search">
          <Icon name="magnifying-glass" size={14} class="af-search-icon" />
          <Input
            id="search-input"
            value={listSearchQuery}
            placeholder="Filter by id or title"
            onInput={(event) =>
              onListSearchChange(
                (event.currentTarget as HTMLInputElement).value,
              )
            }
          />
        </div>

        <div class="af-initiative">
          <label for="filter-status" class="af-initiative-label">
            Status
          </label>
          <Select
            id="filter-status"
            value={listStatusFilter}
            onChange={(event) =>
              onListStatusChange(
                (event.currentTarget as HTMLSelectElement).value,
              )
            }
          >
            {STATUS_FILTERS.map((status) => (
              <option key={status} value={status}>
                {status === "all" ? "All statuses" : statusLabel(status)}
              </option>
            ))}
          </Select>
        </div>

        <InitiativeSelect
          issues={issues}
          initiativeFilter={initiativeFilter}
          onInitiativeChange={onInitiativeChange}
        />

        <p class="af-result-count">
          {filtered.length} issues
          {filtered.length > LIST_ROW_CAP
            ? ` · showing the first ${LIST_ROW_CAP}`
            : ""}
        </p>
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          title="No issues match these filters"
          hint="Clear the search box or widen the status filter."
          live
        />
      ) : (
        <IssueTable
          issues={filtered.slice(0, LIST_ROW_CAP)}
          label="All issues"
          {...tableProps}
        />
      )}
    </Fragment>
  );
}
