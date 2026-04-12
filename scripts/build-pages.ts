#!/usr/bin/env bun
/**
 * build-pages.ts — Generate docs/data/beads.json for the dashboard.
 *
 * 1. Reads `.beads/*.jsonl` when present and non-empty (legacy / file-export flow).
 * 2. If that yields no issues, runs `bd export --no-memories` and normalizes records
 *    (Dolt-backed Beads — the usual case today).
 *
 * Usage: bun run build-pages
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { execFileSync } from "child_process";
import type {
  BeadsIssue,
  BeadsComment,
  BeadsDependency,
  BeadsPayload,
  DerivedData,
  IssuePriority,
  IssueStatus,
  IssueType,
} from "../types/beads.ts";

const ISSUES_FILE = join(process.cwd(), ".beads", "issues.jsonl");
const DEPS_FILE = join(process.cwd(), ".beads", "deps.jsonl");
const COMMENTS_FILE = join(process.cwd(), ".beads", "comments.jsonl");
const OUTPUT_FILE = join(process.cwd(), "docs", "data", "beads.json");

function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => {
      try {
        return JSON.parse(line) as T;
      } catch {
        return null;
      }
    })
    .filter((x): x is T => x !== null);
}

/** One line from `bd export --no-memories` (issue + embedded dependencies). */
interface BdExportRow {
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

function mapNumericPriority(p: number | undefined): IssuePriority | undefined {
  if (p === undefined || Number.isNaN(p)) return undefined;
  if (p <= 0) return "critical";
  if (p === 1) return "high";
  if (p === 2) return "medium";
  return "low";
}

function normalizeStatus(s: string): IssueStatus {
  const allowed: IssueStatus[] = ["open", "in_progress", "closed", "blocked"];
  if (allowed.includes(s as IssueStatus)) return s as IssueStatus;
  return "open";
}

function normalizeIssueType(raw: string | undefined): IssueType {
  const t = (raw ?? "task").toLowerCase();
  const allowed: IssueType[] = ["epic", "feature", "task", "bug", "chore"];
  if (allowed.includes(t as IssueType)) return t as IssueType;
  return "task";
}

function normalizeBdExportRow(raw: BdExportRow): BeadsIssue {
  let parent: string | undefined;
  for (const d of raw.dependencies ?? []) {
    if (d.type === "parent-child" && d.issue_id === raw.id) {
      parent = d.depends_on_id;
      break;
    }
  }
  const createdAt = raw.created_at ?? raw.createdAt ?? new Date().toISOString();
  const updatedAt = raw.updated_at ?? raw.updatedAt ?? createdAt;
  return {
    id: raw.id,
    type: normalizeIssueType(raw.issue_type ?? raw.type),
    title: raw.title,
    description: raw.acceptance_criteria ?? raw.description,
    status: normalizeStatus(raw.status),
    priority: mapNumericPriority(raw.priority),
    parent,
    repo: raw.repo,
    createdAt,
    updatedAt,
    assignee: raw.assignee,
    labels: raw.labels,
  };
}

function collectBlockDeps(rows: BdExportRow[]): BeadsDependency[] {
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

function loadFromBdExport(): {
  issues: BeadsIssue[];
  deps: BeadsDependency[];
  comments: BeadsComment[];
} {
  const stdout = execFileSync("bd", ["export", "--no-memories"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const rows: BdExportRow[] = [];
  for (const line of stdout.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      rows.push(JSON.parse(t) as BdExportRow);
    } catch {
      /* skip bad line */
    }
  }
  const issues = rows.map(normalizeBdExportRow);
  const deps = collectBlockDeps(rows);
  return { issues, deps, comments: [] };
}

let issues = readJsonl<BeadsIssue>(ISSUES_FILE);
let deps = readJsonl<BeadsDependency>(DEPS_FILE);
let comments = readJsonl<BeadsComment>(COMMENTS_FILE);

if (issues.length === 0) {
  try {
    const fromBd = loadFromBdExport();
    issues = fromBd.issues;
    deps = fromBd.deps;
    comments = fromBd.comments;
    if (issues.length > 0) {
      console.log("  (loaded issues via `bd export --no-memories` — JSONL was empty)");
    }
  } catch (e) {
    console.warn(
      "  (no JSONL issues and `bd export` failed — install bd in PATH or export manually):",
      e instanceof Error ? e.message : String(e),
    );
  }
}

// Build derived data
const byStatus = {} as Record<IssueStatus, BeadsIssue[]>;
const byType = {} as Record<IssueType, BeadsIssue[]>;
const byRepo: Record<string, BeadsIssue[]> = {};

for (const issue of issues) {
  (byStatus[issue.status] ??= []).push(issue);
  (byType[issue.type] ??= []).push(issue);
  const repo = issue.repo ?? "_default";
  (byRepo[repo] ??= []).push(issue);
}

// Compute blocked issue IDs (has incoming deps from open issues)
const blockedIds = new Set<string>();
for (const dep of deps) {
  const blocker = issues.find((i) => i.id === dep.to);
  if (blocker && blocker.status !== "closed") {
    blockedIds.add(dep.from);
  }
}

// Ready = open + unclaimed + not blocked
const ready = issues.filter(
  (i) => i.status === "open" && !i.assignee && !blockedIds.has(i.id),
);

// Blocked = open + in blockedIds
const blocked = issues.filter((i) => i.status !== "closed" && blockedIds.has(i.id));

const derived: DerivedData = {
  byStatus,
  byType,
  byRepo,
  ready,
  blocked,
  deps,
};

const payload: BeadsPayload = {
  version: "1.0.0",
  generatedAt: new Date().toISOString(),
  issues,
  comments,
  deps,
  derived,
};

// Write output
mkdirSync(join(process.cwd(), "docs", "data"), { recursive: true });
writeFileSync(OUTPUT_FILE, JSON.stringify(payload, null, 2));

console.log(`✓ Built docs/data/beads.json`);
console.log(`  Issues: ${issues.length}`);
console.log(`  Ready: ${ready.length}`);
console.log(`  Blocked: ${blocked.length}`);
console.log(`  Deps: ${deps.length}`);
