/**
 * Ledger upkeep: dated snapshots and retention.
 *
 * A backup is a consistent SQLite snapshot (`VACUUM INTO`), not a file copy:
 * copying a WAL database while it is being written is not safe. Both functions
 * throw on failure; callers that must not fail (hooks) wrap them.
 */

import { existsSync, mkdirSync, readdirSync, renameSync, unlinkSync } from "fs";
import { dirname, join, resolve } from "path";
import { openLedger } from "./db";
import { backupsDir, ledgerPath } from "./paths";

/** Snapshots older than this many days are removed when a new one is taken. */
export const BACKUP_KEEP_DAYS = 14;
/** Events older than this many days are folded into daily counts by `compact`. */
export const RETENTION_DAYS = 90;

const DAY_MS = 24 * 60 * 60 * 1000;
const BACKUP_NAME = /^ledger-(\d{4})-(\d{2})-(\d{2})\.db$/;

export interface UpkeepOptions {
  /** The ledger file; defaults to the one under `AGENT_FORGE_HOME` / `~/.agent-forge`. */
  path?: string;
  now?: () => Date;
}

function startOfUtcDay(date: Date): number {
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

/** Remove snapshots whose file-name date is more than `BACKUP_KEEP_DAYS` before today. */
function prune(dir: string, today: number): string[] {
  const cutoff = today - BACKUP_KEEP_DAYS * DAY_MS;
  const pruned: string[] = [];
  for (const name of readdirSync(dir)) {
    const match = BACKUP_NAME.exec(name);
    if (!match) continue;
    const day = Date.UTC(
      Number(match[1]),
      Number(match[2]) - 1,
      Number(match[3]),
    );
    if (Number.isNaN(day) || day >= cutoff) continue;
    const file = join(dir, name);
    unlinkSync(file);
    pruned.push(file);
  }
  return pruned;
}

function backupsDirFor(opts: UpkeepOptions & { dir?: string }): string {
  return (
    opts.dir ??
    (opts.path === undefined
      ? backupsDir()
      : join(dirname(resolve(opts.path)), "backups"))
  );
}

function snapshotName(now: Date): string {
  return `ledger-${now.toISOString().slice(0, 10)}.db`;
}

/**
 * Write today's snapshot to `backups/ledger-YYYY-MM-DD.db` beside the ledger
 * (UTC date; a second backup on the same day replaces the first) and prune old
 * snapshots by the date in their file name.
 */
export function backupLedger(opts: UpkeepOptions & { dir?: string } = {}): {
  path: string;
  pruned: string[];
} {
  const now = opts.now?.() ?? new Date();
  const dir = backupsDirFor(opts);
  mkdirSync(dir, { recursive: true });

  const target = join(dir, snapshotName(now));
  // `VACUUM INTO` refuses an existing file, so the snapshot is written beside
  // its final name and moved over it.
  const staging = `${target}.${process.pid}.tmp`;
  const db = openLedger(opts.path ?? ledgerPath());
  try {
    db.query("VACUUM INTO ?").run(staging);
    renameSync(staging, target);
  } catch (error) {
    try {
      unlinkSync(staging);
    } catch {
      // Nothing was written.
    }
    throw error;
  }
  return { path: target, pruned: prune(dir, startOfUtcDay(now)) };
}

/**
 * Take today's snapshot unless one already exists. The stand-in for a nightly
 * job: a session start calls it, so the first session of a day pays for the
 * backup. Never throws; returns whether a snapshot was taken.
 */
export function backupIfDue(
  opts: UpkeepOptions & { dir?: string } = {},
): boolean {
  try {
    const now = opts.now?.() ?? new Date();
    if (existsSync(join(backupsDirFor(opts), snapshotName(now)))) return false;
    backupLedger({ ...opts, now: () => now });
    return true;
  } catch {
    return false;
  }
}

/**
 * Fold events older than `RETENTION_DAYS` into `daily_summaries` (one count
 * per day, workspace and kind) and delete them, in one transaction.
 */
export function compact(opts: UpkeepOptions = {}): {
  events: number;
  days: number;
} {
  const now = opts.now?.() ?? new Date();
  const cutoff = new Date(
    now.getTime() - RETENTION_DAYS * DAY_MS,
  ).toISOString();
  const db = openLedger(opts.path ?? ledgerPath());
  const run = db.transaction((before: string) => {
    const days =
      db
        .query<{ n: number }, [string]>(
          "SELECT count(DISTINCT substr(ts, 1, 10)) AS n FROM events WHERE ts < ?",
        )
        .get(before)?.n ?? 0;
    db.query(
      `INSERT INTO daily_summaries (day, workspace, kind, count)
         SELECT substr(ts, 1, 10), workspace, kind, count(*) FROM events
         WHERE ts < ? GROUP BY 1, 2, 3
       ON CONFLICT(day, workspace, kind) DO UPDATE SET count = count + excluded.count`,
    ).run(before);
    const removed = db.query("DELETE FROM events WHERE ts < ?").run(before);
    return { events: removed.changes, days };
  });
  return run.immediate(cutoff);
}
