/**
 * Pure helpers for turning `bd export` rows + dependency edges into dashboard payload pieces.
 * Used by `build-pages.ts` and unit tests.
 */

import type { BeadsIssue, BeadsDependency, BeadsComment, DerivedData, IssuePriority, IssueStatus, IssueType } from "../types/beads";

/** One line from `bd export --no-memories` (issue + embedded dependencies). */
export interface BdExportRow {
  id: string;
  title: string;
  acceptance_criteria?: string;
  description?: string;
  status: string;
  priority?: number;
  issue_type?: string;
  type?: string;
  repo?: string;
  created_at?: string;
  updated_at?: string;
  createdAt?: string;
  updatedAt?: string;
  assignee?: string;
  owner?: string;
  labels?: string[];
  dependencies?: Array<{ issue_id: string; depends_on_id: string; type: string }>;
}

export function mapNumericPriority(p: number | undefined): IssuePriority | undefined {
  if (p === undefined || Number.isNaN(p)) return undefined;
  if (p <= 0) return "critical";
  if (p === 1) return "high";
  if (p === 2) return "medium";
  return "low";
}

export function normalizeStatus(s: string): IssueStatus {
  const allowed: IssueStatus[] = ["open", "in_progress", "closed", "blocked"];
  if (allowed.includes(s as IssueStatus)) return s as IssueStatus;
  return "open";
}

export function normalizeIssueType(raw: string | undefined): IssueType {
  const t = (raw ?? "task").toLowerCase();
  const allowed: IssueType[] = ["epic", "feature", "task", "bug", "chore"];
  if (allowed.includes(t as IssueType)) return t as IssueType;
  return "task";
}

export function normalizeBdExportRow(raw: BdExportRow): BeadsIssue {
  let parent: string | undefined;
  for (const d of raw.dependencies ?? []) {
    if (d.type === "parent-child" && d.issue_id === raw.id) {
      parent = d.depends_on_id;
      break;
    }
  }
  const createdAt = raw.created_at ?? raw.createdAt ?? new Date().toISOString();
  const updatedAt = raw.updated_at ?? raw.updatedAt ?? createdAt;
  const description = raw.acceptance_criteria ?? raw.description;
  const priority = mapNumericPriority(raw.priority);
  /** `owner` from export is metadata (creator); only `assignee` counts as claimed for derived.ready. */
  const assignee = raw.assignee;

  return {
    id: raw.id,
    type: normalizeIssueType(raw.issue_type ?? raw.type),
    title: raw.title,
    status: normalizeStatus(raw.status),
    createdAt,
    updatedAt,
    ...(description !== undefined ? { description } : {}),
    ...(priority !== undefined ? { priority } : {}),
    ...(parent !== undefined ? { parent } : {}),
    ...(raw.repo !== undefined ? { repo: raw.repo } : {}),
    ...(raw.owner !== undefined ? { owner: raw.owner } : {}),
    ...(assignee !== undefined ? { assignee } : {}),
    ...(raw.labels !== undefined ? { labels: raw.labels } : {}),
  };
}

export function collectBlockDeps(rows: BdExportRow[]): BeadsDependency[] {
  const seen = new Set<string>();
  const out: BeadsDependency[] = [];
  for (const r of rows) {
    for (const d of r.dependencies ?? []) {
      if (d.type !== "blocks") continue;
      const key = `${d.issue_id}\t${d.depends_on_id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ from: d.issue_id, to: d.depends_on_id, type: "blocks" });
    }
  }
  return out;
}

/** Parse newline-delimited `bd export` stdout into rows (skips bad lines). */
export function parseBdExportStdout(stdout: string): BdExportRow[] {
  const rows: BdExportRow[] = [];
  for (const line of stdout.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      rows.push(JSON.parse(t) as BdExportRow);
    } catch {
      /* skip */
    }
  }
  return rows;
}

export function issuesAndDepsFromExportRows(rows: BdExportRow[]): {
  issues: BeadsIssue[];
  deps: BeadsDependency[];
} {
  return {
    issues: rows.map(normalizeBdExportRow),
    deps: collectBlockDeps(rows),
  };
}

/** Same grouping rules as `build-pages.ts` (ready / blocked / byStatus / byType / byRepo). */
export function buildDerivedFromIssuesAndDeps(issues: BeadsIssue[], deps: BeadsDependency[]): DerivedData {
  const byStatus = {} as Record<IssueStatus, BeadsIssue[]>;
  const byType = {} as Record<IssueType, BeadsIssue[]>;
  const byRepo: Record<string, BeadsIssue[]> = {};

  for (const issue of issues) {
    (byStatus[issue.status] ??= []).push(issue);
    (byType[issue.type] ??= []).push(issue);
    const repo = issue.repo ?? "_default";
    (byRepo[repo] ??= []).push(issue);
  }

  const blockedIds = new Set<string>();
  for (const dep of deps) {
    const blocker = issues.find((i) => i.id === dep.to);
    if (blocker && blocker.status !== "closed") {
      blockedIds.add(dep.from);
    }
  }

  const ready = issues.filter(
    (i) => i.status === "open" && !i.assignee && !blockedIds.has(i.id),
  );

  const blocked = issues.filter((i) => i.status !== "closed" && blockedIds.has(i.id));

  return {
    byStatus,
    byType,
    byRepo,
    ready,
    blocked,
    deps,
  };
}

export function payloadFromIssuesDepsComments(
  issues: BeadsIssue[],
  deps: BeadsDependency[],
  comments: BeadsComment[],
): { issues: BeadsIssue[]; comments: BeadsComment[]; deps: BeadsDependency[]; derived: DerivedData } {
  const derived = buildDerivedFromIssuesAndDeps(issues, deps);
  return { issues, comments, deps, derived };
}
