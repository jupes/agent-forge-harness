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
  due?: string;
  due_at?: string;
  estimate?: number | string;
  spent?: number | string;
  closed_by?: string;
  closedBy?: string;
  assignee?: string;
  owner?: string;
  labels?: string[];
  dependencies?: Array<{ issue_id: string; depends_on_id: string; type: string }>;
  /** Present on `bd export` rows; used to decide whether to call `bd comments <id>`. */
  comment_count?: number;
}

/** One element from `bd comments <id> --json` (field names match upstream CLI). */
export interface BdCommentJson {
  issue_id?: string;
  author?: string;
  text?: string;
  created_at?: string;
}

/**
 * Parse stdout from `bd comments <issueId> --json` into normalized dashboard comments.
 */
export function parseBdCommentsJson(json: string, fallbackIssueId: string): BeadsComment[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: BeadsComment[] = [];
  for (const raw of parsed) {
    if (!raw || typeof raw !== "object") continue;
    const o = raw as BdCommentJson;
    const issueId = typeof o.issue_id === "string" && o.issue_id.length > 0 ? o.issue_id : fallbackIssueId;
    const body = typeof o.text === "string" ? o.text : "";
    const author = typeof o.author === "string" ? o.author : "";
    const createdAt =
      typeof o.created_at === "string" && o.created_at.length > 0 ? o.created_at : new Date().toISOString();
    out.push({ issueId, body, author, createdAt });
  }
  return out;
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

function asOptionalNumber(raw: number | string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
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
  const due = raw.due ?? raw.due_at;
  const estimate = asOptionalNumber(raw.estimate);
  const spent = asOptionalNumber(raw.spent);
  const closedBy = raw.closed_by ?? raw.closedBy;
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
    ...(due !== undefined ? { due } : {}),
    ...(estimate !== undefined ? { estimate } : {}),
    ...(spent !== undefined ? { spent } : {}),
    ...(closedBy !== undefined ? { closedBy } : {}),
  };
}

export function collectBlockDeps(rows: BdExportRow[]): BeadsDependency[] {
  const allowedTypes = new Set<BeadsDependency["type"]>(["blocks", "requires", "relates"]);
  const seen = new Set<string>();
  const out: BeadsDependency[] = [];
  for (const r of rows) {
    for (const d of r.dependencies ?? []) {
      if (!allowedTypes.has(d.type as BeadsDependency["type"])) continue;
      const type = d.type as BeadsDependency["type"];
      const key = `${d.issue_id}\t${d.depends_on_id}\t${type}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ from: d.issue_id, to: d.depends_on_id, type });
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
    if (dep.type !== "blocks" && dep.type !== "requires") continue;
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
