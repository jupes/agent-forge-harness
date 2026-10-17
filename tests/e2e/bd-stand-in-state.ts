/**
 * The `bd` stand-in's issues, as one file both the stand-in and the suite's
 * helpers read and write, and the comments it keeps, as another.
 *
 * A write goes to a temporary file that then replaces the state, so a reader
 * never sees half of one. On Windows, replacing or opening a file another
 * process has open fails now and then with `EPERM`, `EBUSY` or `EACCES`
 * (measured: most renames fail while a reader loops), so each read and each
 * replace is tried again, a bounded number of times, before it fails.
 * Stand-in commands and fixture helpers hold `withStateLock` across the whole
 * read/modify/write transaction so simultaneous writers cannot lose updates.
 */

import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { BdIssue } from "../../scripts/hearth/bd-answers";

/** An issue the stand-in keeps: as bd prints it, and the beads that block it. */
export interface StandInIssue extends BdIssue {
  blockedBy?: string[];
}

/** Every issue the stand-in knows, by id. */
export type StandInState = Record<string, StandInIssue>;

const RETRIABLE = new Set(["EPERM", "EBUSY", "EACCES"]);

export interface RetryOptions {
  tries?: number;
  waitMs?: number;
  /** The error codes tried again: the sharing errors unless given. */
  codes?: Iterable<string>;
}

const pause = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

const errorCode = (error: unknown): string =>
  String((error as { code?: unknown } | null)?.code ?? "");

/**
 * Ownerless legacy locks may be recovered after this long. A named live
 * process is never age-broken: a paused holder may still finish its work.
 */
export const STALE_LOCK_MS = 30_000;

export interface LockOptions {
  /** How long to wait for the lock before giving up. */
  waitMs?: number;
  /** How old an ownerless legacy lock must be before it is broken. */
  staleMs?: number;
  /** Make the lock's directory; tests replace it to make it fail. */
  mkdir?: (path: string) => void;
  /** Test interleavings and crash points; absent in the browser stand-in. */
  step?: (
    phase: "break-owned" | "remove-owner" | "remove-empty",
    lock: string,
  ) => void;
}

/** Who holds the lock, written inside it, so a waiter can tell a dead holder. */
interface LockOwner {
  pid: number;
  /** When the lock was taken, in ms since the epoch. */
  at: number;
  /** This holding of the lock: a release removes the lock only while it is still this one. */
  token: string;
}

const ownerFile = (lock: string, owner: LockOwner): string =>
  join(lock, `owner-${owner.pid}-${owner.token}.json`);

function readOwner(lock: string): LockOwner | undefined {
  try {
    const file = readdirSync(lock).find((name) => name.startsWith("owner-"));
    if (!file) return undefined;
    return JSON.parse(
      withRetries(() => readFileSync(join(lock, file), "utf8")),
    ) as LockOwner;
  } catch {
    // None yet (taken a moment ago, or by a holder that died before writing
    // it), or half written: the lock's own age decides.
    return undefined;
  }
}

function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists, it is only not ours to signal.
    return errorCode(error) === "EPERM";
  }
}

/** Whether the lock was left by a holder that died; false when it is gone. */
function stale(lock: string, staleMs: number): boolean {
  const owner = readOwner(lock);
  let since: number;
  if (owner !== undefined) since = owner.at;
  else {
    try {
      since = statSync(lock).mtimeMs;
    } catch {
      return false;
    }
  }
  return owner === undefined
    ? Date.now() - since > staleMs
    : !running(owner.pid);
}

/**
 * Unlink only this holding's unique witness, then remove only an empty
 * directory. A delayed remover cannot empty or remove a fresh publication.
 */
function removeLock(
  lock: string,
  owner: LockOwner | undefined,
  step?: LockOptions["step"],
): void {
  try {
    if (owner) {
      step?.("remove-owner", lock);
      // Only one remover can unlink this holding's unique witness. A loser
      // must not go on to remove a different holding's owner or directory.
      withRetries(() => unlinkSync(ownerFile(lock, owner)));
    }
    step?.("remove-empty", lock);
    withRetries(() => rmdirSync(lock));
  } catch (error) {
    if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(errorCode(error)))
      throw error;
  }
}

/** Publish a nonempty directory in one step, so stale rmdir cannot delete a fresh holder. */
function publish(
  lock: string,
  owner: LockOwner,
  mkdir: (path: string) => void = (path) => mkdirSync(path),
): void {
  const candidate = `${lock}.candidate-${owner.token}`;
  try {
    mkdir(candidate);
    withRetries(() =>
      writeFileSync(ownerFile(candidate, owner), JSON.stringify(owner)),
    );
    // POSIX rename can replace an empty directory. Respect the age of legacy
    // ownerless locks too; competing new publications are always nonempty.
    if (existsSync(lock))
      throw Object.assign(new Error("lock held"), { code: "EEXIST" });
    renameSync(candidate, lock);
  } finally {
    // Canonical locks are never recursively removed. A process killed before
    // publication can leave this harmless sibling for run-home cleanup.
    rmSync(candidate, { recursive: true, force: true, maxRetries: 5 });
  }
}

/**
 * Remove the lock if a dead holder left it. Breakers take a second lock
 * first and judge the lock again inside it, so two waiters that both saw it
 * stale cannot both remove it: the second finds the lock gone, or a live
 * holder's new one, and leaves it.
 */
function breakIfStale(
  lock: string,
  staleMs: number,
  step?: LockOptions["step"],
): void {
  if (!stale(lock, staleMs)) return;
  const breaker = `${lock}.break`;
  const owner: LockOwner = {
    pid: process.pid,
    at: Date.now(),
    token: randomUUID(),
  };
  try {
    publish(breaker, owner);
  } catch (error) {
    if (!["EEXIST", "ENOTEMPTY", ...RETRIABLE].includes(errorCode(error)))
      throw error;
    const held = readOwner(breaker);
    // An empty breaker can be a remover killed after unlink. Fresh breakers
    // are published nonempty, so rmdir is safe without an age wait.
    if (!held || !running(held.pid)) removeLock(breaker, held, step);
    return;
  }
  try {
    step?.("break-owned", breaker);
    const held = readOwner(lock);
    if (held ? !running(held.pid) : stale(lock, staleMs))
      removeLock(lock, held, step);
  } finally {
    removeLock(breaker, owner, step);
  }
}

/**
 * Serialize a whole read/modify/write transaction across stand-in processes.
 *
 * The lock is a populated directory: publishing it is the one step that can
 * succeed for only one process. While another holds it, publication fails;
 * on Windows it can also fail with a sharing error (`EPERM`, `EBUSY`,
 * `EACCES`) while the last holder's directory is still being removed, so a
 * waiter waits on those as well. A holder killed before its `finally` runs
 * leaves the lock behind; the owner it wrote inside lets a waiter break it
 * once the holder's process is gone. Age recovers only ownerless legacy locks.
 */
export function withStateLock<T>(
  dir: string,
  work: () => T,
  {
    waitMs = 5_000,
    staleMs = STALE_LOCK_MS,
    mkdir = (path) => mkdirSync(path),
    step,
  }: LockOptions = {},
): T {
  const lock = join(dir, "state.lock");
  const token = `${process.pid}-${randomUUID()}`;
  const owner: LockOwner = { pid: process.pid, at: Date.now(), token };
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      publish(lock, owner, mkdir);
      break;
    } catch (error) {
      const code = errorCode(error);
      if (code !== "EEXIST" && code !== "ENOTEMPTY" && !RETRIABLE.has(code))
        throw error;
      breakIfStale(lock, staleMs, step);
      if (Date.now() >= deadline)
        throw new Error(`timed out waiting for stand-in state lock: ${lock}`);
      pause(25);
    }
  }
  try {
    return work();
  } finally {
    // Not ours to remove when a waiter broke it as stale and another took it.
    removeLock(lock, owner, step);
  }
}

/**
 * Run `work`, again after a short wait while it fails with a sharing error
 * (or another of `codes`), at most `tries` times in all; any other error, or
 * the last retried one, is thrown.
 */
export function withRetries<T>(
  work: () => T,
  { tries = 40, waitMs = 25, codes = RETRIABLE }: RetryOptions = {},
): T {
  const retried = new Set(codes);
  for (let attempt = 1; ; attempt++) {
    try {
      return work();
    } catch (error) {
      if (!retried.has(errorCode(error)) || attempt >= tries) throw error;
      pause(waitMs);
    }
  }
}

export const stateFile = (dir: string): string => join(dir, "issues.json");

/** A comment the stand-in keeps: what `comments add` was given, and when. */
export interface StandInComment {
  id: string;
  issueId: string;
  author: string;
  text: string;
  /** As `comments add` printed it: to a fraction of a second. */
  createdAt: string;
}

/** Every comment the stand-in keeps, by issue id, oldest first. */
export type StandInComments = Record<string, StandInComment[]>;

/** Beside the issues, not in them: bd's `show` prints an issue without its comments. */
export const commentsFile = (dir: string): string => join(dir, "comments.json");

function readJson<T>(file: string, empty: T, options?: RetryOptions): T {
  if (!existsSync(file)) return empty;
  return JSON.parse(
    withRetries(() => readFileSync(file, "utf8"), options),
  ) as T;
}

function replaceJson(file: string, value: unknown, options?: RetryOptions) {
  const temporary = `${file}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  writeFileSync(temporary, JSON.stringify(value, null, 2));
  try {
    withRetries(() => renameSync(temporary, file), options);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

/** The stand-in's issues; none when it has written none yet. */
export function readState(dir: string, options?: RetryOptions): StandInState {
  return readJson<StandInState>(stateFile(dir), {}, options);
}

/** Replace the stand-in's issues whole; hold withStateLock when modifying existing state. */
export function writeState(
  dir: string,
  state: StandInState,
  options?: RetryOptions,
): void {
  replaceJson(stateFile(dir), state, options);
}

/** The stand-in's comments; none when it has kept none yet. */
export function readComments(
  dir: string,
  options?: RetryOptions,
): StandInComments {
  return readJson<StandInComments>(commentsFile(dir), {}, options);
}

/** Replace the stand-in's comments whole; hold withStateLock when modifying existing state. */
export function writeComments(
  dir: string,
  comments: StandInComments,
  options?: RetryOptions,
): void {
  replaceJson(commentsFile(dir), comments, options);
}
