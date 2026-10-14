#!/usr/bin/env bun

/**
 * Convoy-style bundle planner (MO-03).
 *
 * Given an epic id, emit batches of open/in_progress descendant beads that
 * can run in parallel — each batch contains only tasks whose Beads `blocks`
 * dependencies are already satisfied (closed or in an earlier batch).
 *
 * The graph comes from the live tracker (one `bd export`): parents and
 * blockers are read from each row's dependencies. Only when bd does not answer
 * is `.beads/issues.jsonl` used, and a warning on stderr and `data.source` say
 * so.
 *
 * Usage:
 *   bun run beads:bundles <EPIC-ID>
 *
 * Emits `{ ok, data: { epicId, batches, unbatched, closed, source }, error }`.
 */

import type {
  BeadsDependency,
  BeadsIssue,
  SnapshotSource,
} from "../../types/beads";
import { issuesAndDepsFromExportRows } from "../beads-dashboard";
import { isMain } from "../is-main";
import {
  type BdRunner,
  FALLBACK_FILE,
  fallbackNotice,
  readTrackerRows,
  runBdOnPath,
} from "./live-tracker";

type Graph = {
  issues: BeadsIssue[];
  deps: BeadsDependency[];
  source: SnapshotSource;
};

async function loadGraph(
  cwd: string,
  runBd: BdRunner,
): Promise<{ ok: true; graph: Graph } | { ok: false; error: string }> {
  const read = await readTrackerRows({ cwd, runBd });
  if (!read.ok) {
    return {
      ok: false,
      error: `beads:bundles: \`bd export\` did not answer (${read.reason}), and there are no issues in ${FALLBACK_FILE} to fall back to.`,
    };
  }
  const { issues, deps } = issuesAndDepsFromExportRows(read.rows);
  return { ok: true, graph: { issues, deps, source: read.source } };
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

export type BundlesEnvelope =
  | {
      ok: true;
      /** `source`: where the graph came from, the live tracker or the fallback file. */
      data: BundlePlan & { source: SnapshotSource };
      error: null;
    }
  | { ok: false; data: null; error: string };

/** What `bun run beads:bundles <EPIC-ID>` prints, for the checkout at `cwd`. */
export async function runBundles(options: {
  /** The checkout whose `.beads/issues.jsonl` is the fallback. */
  cwd: string;
  runBd: BdRunner;
  epicId: string;
  warn?: (line: string) => void;
}): Promise<BundlesEnvelope> {
  const { epicId } = options;
  const warn = options.warn ?? ((line: string) => console.error(line));
  const loaded = await loadGraph(options.cwd, options.runBd);
  if (!loaded.ok) return { ok: false, data: null, error: loaded.error };
  const { issues, deps, source } = loaded.graph;
  if (source.kind === "file") warn(`beads:bundles: ${fallbackNotice(source)}`);
  const epic = issues.find((i) => i.id === epicId);
  if (!epic) {
    return { ok: false, data: null, error: `epic not found: ${epicId}` };
  }
  const subtree = collectSubtree(issues, epicId);
  const plan = planBundles(epicId, subtree, deps);
  return { ok: true, data: { ...plan, source }, error: null };
}

if (isMain(import.meta)) {
  const epicId = process.argv[2];
  const envelope: BundlesEnvelope = epicId
    ? await runBundles({ cwd: process.cwd(), runBd: runBdOnPath, epicId })
    : {
        ok: false,
        data: null,
        error: "usage: bun run beads:bundles <EPIC-ID>",
      };
  console.log(JSON.stringify(envelope, null, 2));
  if (!envelope.ok) process.exit(1);
}
