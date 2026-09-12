/**
 * The selection rules behind the Dashboard and All-issues views.
 *
 * Kept out of the component so the counts, caps and sort orders — including
 * two long-standing quirks that must not be "tidied" — are pinned by tests.
 */

import type { BeadsIssue, BeadsPayload } from "../../../types/beads";
import {
  applyInitiativeFilter,
  issuesInProgress,
  sortByUpdatedDesc,
} from "../issues-selection.mjs";

/** Rows rendered by All issues before truncation. */
export const LIST_ROW_CAP = 100;

const CAPS = {
  inProgress: 25,
  ready: 15,
  blocked: 15,
  closed: 25,
} as const;

export interface DashboardSection {
  /** Rows to render (already capped). */
  rows: BeadsIssue[];
  /** How many matched in total — the heading shows this, not `rows.length`. */
  total: number;
}

export interface DashboardSections {
  stats: {
    open: number;
    inProgress: number;
    blocked: number;
    closed: number;
  };
  inProgress: DashboardSection;
  ready: DashboardSection;
  blocked: DashboardSection;
  closed: DashboardSection;
}

export function dashboardSections(
  payload: BeadsPayload,
  initiativeFilter: string,
): DashboardSections {
  const issues = payload.issues ?? [];
  const derived = payload.derived;

  const openAll = applyInitiativeFilter(
    derived?.byStatus?.open ?? [],
    initiativeFilter,
  );
  const inProgressAll = applyInitiativeFilter(
    issuesInProgress(issues),
    initiativeFilter,
  ).sort(sortByUpdatedDesc);
  const readyAll = applyInitiativeFilter(
    derived?.ready ?? [],
    initiativeFilter,
  );
  const blockedAll = applyInitiativeFilter(
    derived?.blocked ?? [],
    initiativeFilter,
  );
  const closedAll = applyInitiativeFilter(
    derived?.byStatus?.closed ?? [],
    initiativeFilter,
  )
    .slice()
    .sort(sortByUpdatedDesc);

  return {
    stats: {
      open: openAll.length,
      // Unfiltered, the stat card counts strictly `in_progress` while the
      // section heading below it uses the broader "in progress or claimed"
      // definition, so the two can disagree. Long-standing behavior, preserved
      // deliberately: changing it would silently move a number people read.
      inProgress:
        initiativeFilter === "all"
          ? (derived?.byStatus?.in_progress ?? []).length
          : inProgressAll.length,
      blocked: blockedAll.length,
      closed: closedAll.length,
    },
    inProgress: {
      rows: inProgressAll.slice(0, CAPS.inProgress),
      total: inProgressAll.length,
    },
    ready: { rows: readyAll.slice(0, CAPS.ready), total: readyAll.length },
    blocked: {
      rows: blockedAll.slice(0, CAPS.blocked),
      total: blockedAll.length,
    },
    closed: { rows: closedAll.slice(0, CAPS.closed), total: closedAll.length },
  };
}

export interface ListFilters {
  search: string;
  status: string;
  initiative: string;
}

export function filterListIssues(
  issues: BeadsIssue[],
  filters: ListFilters,
): BeadsIssue[] {
  const search = filters.search.toLowerCase();
  return applyInitiativeFilter(issues, filters.initiative).filter((issue) => {
    const matchesStatus =
      filters.status === "all" || issue.status === filters.status;
    const matchesSearch =
      !search ||
      issue.title.toLowerCase().includes(search) ||
      issue.id.toLowerCase().includes(search);
    return matchesStatus && matchesSearch;
  });
}

/**
 * Open blockers per issue.
 *
 * Only `blocks`/`requires` relations count, and a blocker that is already
 * closed does not — otherwise finished work would keep flagging its dependents.
 */
export function activeBlockerIdsByIssue(
  issues: BeadsIssue[],
  deps: BeadsPayload["deps"],
): Map<string, string[]> {
  const byId = new Map<string, BeadsIssue>();
  for (const issue of issues) byId.set(issue.id, issue);

  const out = new Map<string, string[]>();
  for (const dep of deps ?? []) {
    if (dep.type !== "blocks" && dep.type !== "requires") continue;
    const blocker = byId.get(dep.to);
    if (!blocker || blocker.status === "closed") continue;
    const list = out.get(dep.from) ?? [];
    if (!list.includes(dep.to)) list.push(dep.to);
    out.set(dep.from, list);
  }
  return out;
}
