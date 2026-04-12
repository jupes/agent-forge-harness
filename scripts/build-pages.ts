#!/usr/bin/env bun
/**
 * build-pages.ts — Generate docs/data/beads.json from .beads/issues.jsonl
 *
 * Usage: bun run build-pages
 *
 * Reads issue data, builds dependency graph, enriches with metadata,
 * and writes a BeadsPayload JSON file for the dashboard.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import type { BeadsIssue, BeadsComment, BeadsDependency, BeadsPayload, DerivedData, IssueStatus, IssueType } from "../types/beads.ts";

const ISSUES_FILE = join(process.cwd(), ".beads", "issues.jsonl");
const DEPS_FILE = join(process.cwd(), ".beads", "deps.jsonl");
const COMMENTS_FILE = join(process.cwd(), ".beads", "comments.jsonl");
const OUTPUT_FILE = join(process.cwd(), "docs", "data", "beads.json");

function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(line => line.trim())
    .map(line => {
      try { return JSON.parse(line) as T; } catch { return null; }
    })
    .filter((x): x is T => x !== null);
}

// Load data
const issues = readJsonl<BeadsIssue>(ISSUES_FILE);
const deps = readJsonl<BeadsDependency>(DEPS_FILE);
const comments = readJsonl<BeadsComment>(COMMENTS_FILE);

// Build derived data
const byStatus = {} as Record<IssueStatus, BeadsIssue[]>;
const byType = {} as Record<IssueType, BeadsIssue[]>;
const byRepo: Record<string, BeadsIssue[]> = {};

for (const issue of issues) {
  // byStatus
  (byStatus[issue.status] ??= []).push(issue);
  // byType
  (byType[issue.type] ??= []).push(issue);
  // byRepo
  const repo = issue.repo ?? "_default";
  (byRepo[repo] ??= []).push(issue);
}

// Compute blocked issue IDs (has incoming deps from open issues)
const blockedIds = new Set<string>();
for (const dep of deps) {
  // If the "to" (blocker) issue is open, "from" is blocked
  const blocker = issues.find(i => i.id === dep.to);
  if (blocker && blocker.status !== "closed") {
    blockedIds.add(dep.from);
  }
}

// Ready = open + unclaimed + not blocked
const ready = issues.filter(i =>
  i.status === "open" &&
  !i.assignee &&
  !blockedIds.has(i.id)
);

// Blocked = open + in blockedIds
const blocked = issues.filter(i =>
  i.status !== "closed" &&
  blockedIds.has(i.id)
);

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
