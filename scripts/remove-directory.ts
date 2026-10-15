/**
 * Remove a directory tree, and ride out the moments Windows will not let go.
 *
 * Bun 1.3.10's `rmSync` ignores `maxRetries` and `retryDelay`: a directory
 * something still holds (a file another process has open, a child process's
 * working directory) fails at once with EBUSY, whatever the options say. So the
 * retry is done here: a few attempts, a short wait between them, then the last
 * error is thrown. Only the errors a lock gives are retried; any other error is
 * the caller's at once. The wait blocks the thread, so this is for a cleanup,
 * not for a path that serves requests.
 */

import { rmSync } from "fs";

export interface RemoveOptions {
  /** Attempts in all, the first included. Default 5. */
  attempts?: number;
  /** Wait between one attempt and the next, in milliseconds. Default 100. */
  delayMs?: number;
  /** Removes the tree, or throws. Default: `rmSync` (recursive, force). */
  remove?: (path: string) => void;
  /** Waits. Default: `sleepSync`. */
  sleep?: (ms: number) => void;
}

/** What a busy or half-released tree fails with, on Windows and elsewhere. */
const LOCK_CODES: ReadonlySet<string> = new Set([
  "EBUSY",
  "EPERM",
  "ENOTEMPTY",
  "EMFILE",
  "ENFILE",
]);

function isLock(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    LOCK_CODES.has(error.code)
  );
}

/** Wait without leaving the call: block on a value nobody will set, until the time is up. */
export function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Remove `path` and everything under it, by that exact path. A path that is
 * already gone is no error. Throws the last error when a lock outlasts the
 * attempts, and at once for an error that is not a lock.
 */
export function removeDirectory(
  path: string,
  options: RemoveOptions = {},
): void {
  const attempts = Math.max(1, options.attempts ?? 5);
  const delayMs = options.delayMs ?? 100;
  const remove =
    options.remove ??
    ((target: string) => rmSync(target, { recursive: true, force: true }));
  const sleep = options.sleep ?? sleepSync;
  for (let attempt = 1; ; attempt++) {
    try {
      remove(path);
      return;
    } catch (error) {
      if (attempt >= attempts || !isLock(error)) throw error;
      sleep(delayMs);
    }
  }
}
