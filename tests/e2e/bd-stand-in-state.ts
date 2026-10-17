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

import type * as BunFfi from "bun:ffi";
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
 * An ownerless lock may be recovered after this long. A lock names its holder
 * and is judged by that holder's process instead (`holderGone`).
 */
export const STALE_LOCK_MS = 30_000;

/**
 * How old an owned lock must be before it is broken although a process with
 * its pid runs, used only when that process's start time cannot be compared
 * with the one the holder recorded: under Node on Windows (Playwright's
 * workers), on macOS, or when the OS will not say. Then a holder killed
 * mid-transaction whose pid Windows hands to another process would otherwise
 * wedge the lock for the rest of the run. A real transaction reads and
 * replaces two small files, a few seconds at most even with every retry spent,
 * so five minutes breaks only a holder that is paused, never one at work; the
 * cost is that a holder stopped for longer (a debugger) can lose its lock.
 * Where the start times compare (Linux, and Bun on Windows: the stand-in
 * itself and the unit tests) a live holder is never age-broken.
 */
export const OWNED_LOCK_MS = 5 * 60_000;

export interface LockOptions {
  /** How long to wait for the lock before giving up. */
  waitMs?: number;
  /** How old an ownerless lock must be before it is broken. */
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
  /**
   * When the holder's process started, as `processStarted` read it: compared
   * with the start of whatever process has the pid now, so a pid handed to a
   * later process is not taken for the holder. Absent where it cannot be read.
   */
  started?: string;
}

/** The owner witness of one holding: unique, so only one remover can unlink it. */
const ownerName = (owner: LockOwner): string =>
  `owner-${owner.pid}-${owner.token}.json`;

/**
 * The owner file before the witnesses were named by holding. Each browser run
 * makes a fresh home (`HEARTH_HOME` in `servers.ts`), so a lock in this format
 * meets this code only in a home reused across versions (`AGENT_FORGE_E2E_HOME`
 * set by hand). It is read and removed like a witness so such a lock is judged
 * by its holder and cannot wedge removal with `ENOTEMPTY`.
 */
const LEGACY_OWNER = "owner.json";

/** A lock's owner, and the name of the file inside the lock that holds it. */
interface Holding {
  owner: LockOwner;
  file: string;
}

function readOwner(lock: string): Holding | undefined {
  try {
    const file = readdirSync(lock).find(
      (name) => name.startsWith("owner-") || name === LEGACY_OWNER,
    );
    if (!file) return undefined;
    const owner = JSON.parse(
      withRetries(() => readFileSync(join(lock, file), "utf8")),
    ) as LockOwner;
    return { owner, file };
  } catch {
    // Gone, or emptied by a remover between listing and reading: the lock's
    // own age decides. A lock is published with its witness already inside,
    // so an ownerless one is a breaker whose remover was killed after the
    // unlink, or a legacy lock taken by a holder that died before writing it.
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

/** `PROCESS_QUERY_LIMITED_INFORMATION`: enough for `GetProcessTimes`. */
const QUERY_LIMITED = 0x1000;

/** kernel32's process-time calls; kernel32 is a known DLL, loaded from System32. */
function openKernel32(ffi: typeof BunFfi) {
  const { dlopen, FFIType } = ffi;
  const { symbols } = dlopen("kernel32.dll", {
    OpenProcess: {
      args: [FFIType.u32, FFIType.i32, FFIType.u32],
      returns: FFIType.ptr,
    },
    GetProcessTimes: {
      args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr],
      returns: FFIType.i32,
    },
    CloseHandle: { args: [FFIType.ptr], returns: FFIType.i32 },
  });
  return { api: symbols, ptr: ffi.ptr };
}

let kernel32: ReturnType<typeof openKernel32> | null | undefined;

/**
 * kernel32 through `bun:ffi`, loaded once; null under Node, where `bun:ffi`
 * is not found. Looked up rather than imported, as
 * `scripts/hearth/acl-windows.ts` does: Playwright loads this module under
 * Node, and importing a `bun:` module there fails as the module loads.
 */
function processTimes(): ReturnType<typeof openKernel32> | null {
  if (kernel32 !== undefined) return kernel32;
  kernel32 = null;
  const ffi =
    typeof process.getBuiltinModule === "function"
      ? (process.getBuiltinModule("bun:ffi") as object | undefined)
      : undefined;
  if (ffi === undefined || !("dlopen" in ffi)) return kernel32;
  try {
    // The runtime's own `bun:ffi`, checked above: the lookup's type cannot name it.
    kernel32 = openKernel32(ffi as typeof BunFfi);
  } catch {
    kernel32 = null;
  }
  return kernel32;
}

/**
 * When process `pid` started, as an opaque string only compared for equality
 * with another reading; undefined when it cannot be read (no such process, a
 * process the OS will not open for us, or a platform with no cheap source).
 * A process that has exited while another still holds a handle to it (or an
 * unreaped zombie on Linux) keeps its start: `running` is what says it ended.
 *
 * - Linux: field 22 of `/proc/<pid>/stat`, the start in clock ticks after
 *   boot. The command name before it is in parentheses and may hold spaces,
 *   so the fields are counted from the last `)`.
 * - Windows under Bun: the creation `FILETIME` from `GetProcessTimes`, through
 *   `bun:ffi`. A few microseconds; no child process.
 * - Windows under Node, and macOS: undefined. Spawning `wmic`, PowerShell or
 *   `ps` per judgement costs tens to hundreds of milliseconds a poll.
 */
export function processStarted(pid: number): string | undefined {
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  if (process.platform === "linux") {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const fields = stat
        .slice(stat.lastIndexOf(")") + 1)
        .trim()
        .split(/\s+/);
      // fields[0] is field 3 (state), so field 22 (starttime) is fields[19].
      const ticks = fields[19];
      return ticks !== undefined && /^\d+$/.test(ticks) ? ticks : undefined;
    } catch {
      return undefined;
    }
  }
  if (process.platform !== "win32") return undefined;
  const windows = processTimes();
  if (windows === null) return undefined;
  const handle = windows.api.OpenProcess(QUERY_LIMITED, 0, pid);
  if (handle === null) return undefined;
  try {
    // Creation, exit, kernel and user time: four FILETIMEs.
    const times = new BigUint64Array(4);
    const read = windows.api.GetProcessTimes(
      handle,
      windows.ptr(times, 0),
      windows.ptr(times, 8),
      windows.ptr(times, 16),
      windows.ptr(times, 24),
    );
    return read !== 0 && times[0] !== 0n ? String(times[0]) : undefined;
  } finally {
    windows.api.CloseHandle(handle);
  }
}

/**
 * Whether the process that wrote `owner` is gone: no process has its pid, or
 * the one that has it started at a different time than the holder recorded
 * (the holder died and the pid was handed on). When the start times cannot
 * be compared, a running pid is trusted for `OWNED_LOCK_MS` from the taking.
 */
function holderGone(owner: LockOwner): boolean {
  if (!running(owner.pid)) return true;
  const now =
    owner.started === undefined ? undefined : processStarted(owner.pid);
  if (now !== undefined) return now !== owner.started;
  return Date.now() - owner.at > OWNED_LOCK_MS;
}

/** Whether the lock was left by a holder that died; false when it is gone. */
function stale(lock: string, staleMs: number): boolean {
  const held = readOwner(lock);
  if (held !== undefined) return holderGone(held.owner);
  try {
    return Date.now() - statSync(lock).mtimeMs > staleMs;
  } catch {
    return false;
  }
}

/**
 * Unlink only this holding's unique witness, then remove only an empty
 * directory. A delayed remover cannot empty or remove a fresh publication.
 * `witness` is the owner file's name inside `lock`; undefined for a lock
 * judged ownerless.
 */
function removeLock(
  lock: string,
  witness: string | undefined,
  step?: LockOptions["step"],
): void {
  try {
    if (witness !== undefined) {
      step?.("remove-owner", lock);
      // Only one remover can unlink this holding's unique witness. A loser
      // must not go on to remove a different holding's owner or directory.
      withRetries(() => unlinkSync(join(lock, witness)));
    }
    step?.("remove-empty", lock);
    withRetries(() => rmdirSync(lock));
  } catch (error) {
    if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(errorCode(error)))
      throw error;
  }
}

/** This process's start, read once: null until then. */
let ownStart: string | undefined | null = null;

/** An owner record for a holding by this process, with its start when it can be read. */
function holding(token: string): LockOwner {
  if (ownStart === null) ownStart = processStarted(process.pid);
  const owner: LockOwner = { pid: process.pid, at: Date.now(), token };
  if (ownStart !== undefined) owner.started = ownStart;
  return owner;
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
    // Stamped as it is written: a waiter may have waited before this attempt.
    const taken: LockOwner = { ...owner, at: Date.now() };
    withRetries(() =>
      writeFileSync(join(candidate, ownerName(owner)), JSON.stringify(taken)),
    );
    // POSIX rename can replace an empty directory. Respect the age of
    // ownerless locks too; competing new publications are always nonempty.
    if (existsSync(lock))
      throw Object.assign(new Error("lock held"), { code: "EEXIST" });
    renameSync(candidate, lock);
  } finally {
    // Canonical locks are never recursively removed; only this attempt's own
    // candidate is. A process killed between making the candidate and this
    // line leaves a `<lock>.candidate-<token>` directory beside the lock.
    // It is harmless: no one reads it (owners are read only inside the lock
    // itself), its name is unique so no later attempt collides with it, and
    // it lives in the run's home, which teardown removes with everything in
    // it (`global-teardown.ts`; `sweepFinishedRunHomes` for a run that died).
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
  const owner = holding(randomUUID());
  try {
    publish(breaker, owner);
  } catch (error) {
    if (!["EEXIST", "ENOTEMPTY", ...RETRIABLE].includes(errorCode(error)))
      throw error;
    const held = readOwner(breaker);
    // An empty breaker can be a remover killed after unlink. Fresh breakers
    // are published nonempty, so rmdir is safe without an age wait.
    if (!held || holderGone(held.owner)) removeLock(breaker, held?.file, step);
    return;
  }
  try {
    step?.("break-owned", breaker);
    const held = readOwner(lock);
    if (held ? holderGone(held.owner) : stale(lock, staleMs))
      removeLock(lock, held?.file, step);
  } finally {
    removeLock(breaker, ownerName(owner), step);
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
 * once the holder's process is gone, or once its pid names a process that
 * started later (`holderGone`). Age alone recovers an ownerless lock.
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
  const owner = holding(`${process.pid}-${randomUUID()}`);
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
    removeLock(lock, ownerName(owner), step);
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
