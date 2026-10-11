/**
 * The queue lock: one holder at a time, across processes.
 *
 * `bd` has no compare-and-set for labels, and nothing it prints tells the
 * second of two writers that it was second. So a queue move reads, checks and
 * writes while holding this lock, and a second mover reads the first one's
 * result.
 *
 * The lock is a write transaction held on a small SQLite file of its own.
 * There is no stale lock to judge and nothing to take over: the operating
 * system drops the lock when the holder's process ends, however it ends, and
 * a live holder keeps it until its work is done. It is one lock, not one per
 * bead.
 *
 * It serializes the processes that are given the same file. Two processes
 * given different files over one tracker are not serialized by it.
 */

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { safeMessage } from "../hearth/api";

export interface QueueLockOptions {
  /** How long to wait for the lock before answering busy; 10 s by default. */
  waitMs?: number;
}

export type Locked<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      /** `busy`: someone else held it for the whole wait. `unusable`: the file cannot be a lock. */
      reason: "busy" | "unusable";
      error: string;
    };

const DEFAULT_WAIT_MS = 10_000;
/**
 * How far apart attempts are. A failed attempt costs about 30 ms of
 * synchronous time under this runtime, so attempts are kept sparse and, per
 * process, only the caller at the head of the line makes them.
 */
const POLL_MS = { min: 50, spread: 50 };

const sleep = (ms: number): Promise<void> =>
  new Promise((done) => setTimeout(done, ms));

/** The callers of this process waiting on each lock file, as the tail of their line. */
const lines = new Map<string, Promise<void>>();

function isBusy(error: unknown): boolean {
  const code = String((error as { code?: unknown } | null)?.code ?? "");
  const message = error instanceof Error ? error.message : String(error);
  return /BUSY|LOCKED/i.test(code) || /database is locked/i.test(message);
}

type Attempt = { db: Database } | { busy: true } | { unusable: string };

function attempt(file: string): Attempt {
  let db: Database | undefined;
  try {
    db = new Database(file, { create: true });
    db.exec("PRAGMA busy_timeout = 0");
    db.exec("BEGIN EXCLUSIVE");
    return { db };
  } catch (error) {
    try {
      db?.close();
    } catch {
      // Nothing was held by a connection that could not begin.
    }
    return isBusy(error) ? { busy: true } : { unusable: safeMessage(error) };
  }
}

/** Closing the connection frees the lock whatever the commit said; neither may throw over the work's result. */
function release(db: Database): void {
  try {
    db.exec("COMMIT");
  } catch {
    // The close below still frees the lock.
  }
  try {
    db.close();
  } catch {
    // The process's exit frees it.
  }
}

/**
 * Run `work` while holding the lock at `file`. A thrown error from `work` is
 * the caller's, after the lock is released. Busy and unusable are answers,
 * not errors, and `work` was not called for either.
 */
export async function withQueueLock<T>(
  file: string,
  work: () => Promise<T>,
  options: QueueLockOptions = {},
): Promise<Locked<T>> {
  const path = resolve(file);
  const deadline = Date.now() + (options.waitMs ?? DEFAULT_WAIT_MS);
  const busy: Locked<T> = {
    ok: false,
    reason: "busy",
    error: "another queue action is in progress; nothing was done. Try again.",
  };

  // Join the line of this process's callers: only its head asks SQLite.
  const ahead = lines.get(path) ?? Promise.resolve();
  let leave: () => void = () => undefined;
  const mine = new Promise<void>((done) => {
    leave = done;
  });
  const tail = ahead.then(() => mine);
  lines.set(path, tail);

  try {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const myTurn = await Promise.race([
      ahead.then(() => true),
      new Promise<boolean>((done) => {
        timer = setTimeout(() => done(false), deadline - Date.now());
      }),
    ]);
    clearTimeout(timer);
    // A turn that comes after the deadline makes no attempt: an attempt costs
    // synchronous time, and the callers behind this one would wait for it.
    if (!myTurn || Date.now() >= deadline) return busy;

    try {
      mkdirSync(dirname(path), { recursive: true });
    } catch {
      // The file system's message names the path; it is not passed on.
      return unusable("its directory could not be made");
    }
    for (;;) {
      const tried = attempt(path);
      if ("unusable" in tried) return unusable(tried.unusable);
      if ("db" in tried) {
        try {
          return { ok: true, value: await work() };
        } finally {
          release(tried.db);
        }
      }
      const wait = POLL_MS.min + Math.random() * POLL_MS.spread;
      if (Date.now() + wait > deadline) return busy;
      await sleep(wait);
    }
  } finally {
    leave();
    if (lines.get(path) === tail) lines.delete(path);
  }
}

/** The answer names no path: it reaches the operator API, which does not show where the harness home is. */
function unusable<T>(why: string): Locked<T> {
  return {
    ok: false,
    reason: "unusable",
    error: `the queue lock could not be taken (${why}); nothing was done`,
  };
}
