#!/usr/bin/env bun
/**
 * Patrol: list actively-worked Beads issues stale by `updatedAt` (Gas Town Witness/Deacon–style signal, lightweight).
 *
 * "Actively worked" matches dashboard `in_progress` list: `status === in_progress` OR (`open` && `assignee`).
 *
 * Env:
 *   STALE_DAYS — minimum whole days since `updatedAt` to flag (default 7).
 *
 * Output: JSON envelope `{ ok, data, error }` per AGENTS.md.
 */

import type { BeadsIssue } from "../../types/beads";
import { loadBeadsGraph } from "./load-issues";

export type StalePatrolItem = {
  id: string;
  title: string;
  status: string;
  assignee?: string;
  type: string;
  updatedAt: string;
  daysSinceUpdated: number;
};

/** Aligns with docs/js/app.mjs `issuesInProgress`. */
export function isActivelyWorkedIssue(i: BeadsIssue): boolean {
  return i.status === "in_progress" || (i.status === "open" && Boolean(i.assignee?.trim()));
}

export function wholeDaysBetween(isoUpdated: string, nowMs: number): number {
  const t = Date.parse(isoUpdated);
  if (Number.isNaN(t)) return 0;
  return Math.floor((nowMs - t) / 86_400_000);
}

export function findStaleActivelyWorked(
  issues: BeadsIssue[],
  thresholdDays: number,
  nowMs: number,
): StalePatrolItem[] {
  const out: StalePatrolItem[] = [];
  for (const i of issues) {
    if (!isActivelyWorkedIssue(i)) continue;
    const days = wholeDaysBetween(i.updatedAt, nowMs);
    if (days < thresholdDays) continue;
    const row: StalePatrolItem = {
      id: i.id,
      title: i.title,
      status: i.status,
      type: i.type,
      updatedAt: i.updatedAt,
      daysSinceUpdated: days,
    };
    const a = i.assignee?.trim();
    if (a) row.assignee = a;
    out.push(row);
  }
  out.sort((a, b) => b.daysSinceUpdated - a.daysSinceUpdated);
  return out;
}

function parseThreshold(): number {
  const raw = process.env["STALE_DAYS"]?.trim() ?? "7";
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return 7;
  return Math.floor(n);
}

function main(): void {
  const thresholdDays = parseThreshold();
  const nowMs = Date.now();
  let issues: BeadsIssue[];
  try {
    issues = loadBeadsGraph().issues;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log(JSON.stringify({ ok: false, data: null, error: msg }, null, 2));
    process.exit(1);
  }
  const items = findStaleActivelyWorked(issues, thresholdDays, nowMs);
  console.log(
    JSON.stringify(
      {
        ok: true,
        data: {
          thresholdDays,
          generatedAt: new Date(nowMs).toISOString(),
          signal: "days_since_updatedAt",
          count: items.length,
          items,
        },
        error: null,
      },
      null,
      2,
    ),
  );
}

if (import.meta.main) {
  main();
}
