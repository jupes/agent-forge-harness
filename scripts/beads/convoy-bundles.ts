#!/usr/bin/env bun

/**
 * Convoy-style bundle planner (MO-03).
 *
 * Given an epic id, emit batches of open/in_progress descendant beads that
 * can run in parallel — each batch contains only tasks whose Beads `blocks`
 * dependencies are already satisfied (closed or in an earlier batch).
 *
 * Usage:
 *   bun run beads:bundles <EPIC-ID>
 *
 * Emits `{ ok, data: { epicId, batches, unbatched, closed }, error }`.
 */

import { execFileSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import type { BeadsDependency, BeadsIssue } from "../../types/beads";
import {
  issuesAndDepsFromExportRows,
  parseBdExportStdout,
} from "../beads-dashboard";

const ISSUES_FILE = join(process.cwd(), ".beads", "issues.jsonl");
const DEPS_FILE = join(process.cwd(), ".beads", "deps.jsonl");

function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  const out: T[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      /* skip */
    }
  }
  return out;
}

function loadGraph(): { issues: BeadsIssue[]; deps: BeadsDependency[] } {
  let issues = readJsonl<BeadsIssue>(ISSUES_FILE);
  let deps = readJsonl<BeadsDependency>(DEPS_FILE);
  if (issues.length === 0) {
    const stdout = execFileSync("bd", ["export", "--no-memories"], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const rows = parseBdExportStdout(stdout);
    const built = issuesAndDepsFromExportRows(rows);
    issues = built.issues;
    deps = built.deps;
  }
  return { issues, deps };
}

/** Issues in the parent-child subtree rooted at epicId (bead `parent` field). */
export function collectSubtree(
  issues: BeadsIssue[],
  epicId: string,
): BeadsIssue[] {
  const childrenByParent = new Map<string, BeadsIssue[]>();
  for (const i of issues) {
    const p = i.parent;
    if (!p) continue;
    let arr = childrenByParent.get(p);
    if (!arr) {
      arr = [];
      childrenByParent.set(p, arr);
    }
    arr.push(i);
  }
  const byId = new Map<string, BeadsIssue>();
  for (const i of issues) byId.set(i.id, i);
  const stack = [epicId];
  const seen = new Set<string>();
  const out: BeadsIssue[] = [];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const issue = byId.get(id);
    if (issue && id !== epicId) out.push(issue);
    const kids = childrenByParent.get(id);
    if (kids) for (const k of kids) stack.push(k.id);
  }
  return out;
}

export type BundlePlan = {
  epicId: string;
  batches: string[][];
  unbatched: string[];
  closed: string[];
};

/**
 * Layer-by-layer topological scheduler. A task enters batch N when all of its
 * `blocks`/`requires` deps that are still open/in_progress are in batches < N.
 * Closed deps are satisfied immediately.
 */
export function planBundles(
  epicId: string,
  subtree: BeadsIssue[],
  deps: BeadsDependency[],
): BundlePlan {
  const closed: string[] = [];
  const active = new Map<string, BeadsIssue>();
  for (const i of subtree) {
    if (i.status === "closed") closed.push(i.id);
    else active.set(i.id, i);
  }

  // Build blocker-of-me map: for each active task, which *active* ids block it.
  const blockers = new Map<string, Set<string>>();
  for (const id of active.keys()) blockers.set(id, new Set());
  for (const d of deps) {
    if (d.type !== "blocks" && d.type !== "requires") continue;
    // In BeadsDependency: `from` is blocked, `to` must complete first.
    if (!active.has(d.from)) continue;
    if (!active.has(d.to)) continue;
    blockers.get(d.from)!.add(d.to);
  }

  const batches: string[][] = [];
  let remaining = new Set(active.keys());
  while (remaining.size > 0) {
    const ready: string[] = [];
    for (const id of remaining) {
      if (blockers.get(id)!.size === 0) ready.push(id);
    }
    if (ready.length === 0) break; // cycle or unresolved blocker
    ready.sort();
    batches.push(ready);
    for (const id of ready) {
      remaining.delete(id);
      for (const bl of blockers.values()) bl.delete(id);
    }
  }

  const unbatched = Array.from(remaining).sort();
  return { epicId, batches, unbatched, closed };
}

function main(): void {
  const epicId = process.argv[2];
  if (!epicId) {
    console.log(
      JSON.stringify(
        {
          ok: false,
          data: null,
          error: "usage: bun run beads:bundles <EPIC-ID>",
        },
        null,
        2,
      ),
    );
    process.exit(1);
  }
  let graph: { issues: BeadsIssue[]; deps: BeadsDependency[] };
  try {
    graph = loadGraph();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log(JSON.stringify({ ok: false, data: null, error: msg }, null, 2));
    process.exit(1);
  }
  const { issues, deps } = graph!;
  const epic = issues.find((i) => i.id === epicId);
  if (!epic) {
    console.log(
      JSON.stringify(
        { ok: false, data: null, error: `epic not found: ${epicId}` },
        null,
        2,
      ),
    );
    process.exit(1);
  }
  const subtree = collectSubtree(issues, epicId);
  const plan = planBundles(epicId, subtree, deps);
  console.log(JSON.stringify({ ok: true, data: plan, error: null }, null, 2));
}

if (import.meta.main) {
  main();
}
