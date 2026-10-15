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

import { realpathSync, rmSync } from "fs";
import { tmpdir } from "os";
import { basename } from "path";

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
 * Why `name`, the last segment of a path, cannot be taken for the directory it
 * seems to name, or null when it can. Windows strips trailing dots and spaces
 * from it, so `...` and `. ` and `x.` are read as the directory above, `x` and
 * `x`: a remove of `<dir>\...` removes `<dir>`. The same rule is applied on
 * every platform, so a test on Linux shows what Windows would do.
 */
export function nameProblem(name: string): string | null {
  if (name === "") return "is empty";
  if (/[. ]$/.test(name)) return "ends in a dot or a space";
  return null;
}

/** Whether `path` is, once links are resolved, the OS temp directory itself. */
function isOsTempDirectory(path: string): boolean {
  try {
    return realpathSync.native(path) === realpathSync.native(tmpdir());
  } catch {
    return false;
  }
}

/**
 * Remove `path` and everything under it, by that exact path. A path that is
 * already gone is no error. Throws the last error when a lock outlasts the
 * attempts, and at once for an error that is not a lock.
 *
 * Refused, with nothing removed and no attempt made: a path whose last segment
 * is empty or ends in a dot or a space (`nameProblem`), which on Windows can
 * name the directory above it; and the OS temp directory itself. Beyond that
 * it removes what it is given: a caller that takes paths from elsewhere checks
 * them first (`scripts/test-scratch.ts`).
 */
export function removeDirectory(
  path: string,
  options: RemoveOptions = {},
): void {
  const problem = nameProblem(basename(path));
  if (problem !== null) {
    throw new Error(
      `remove-directory: refusing to remove ${JSON.stringify(path)}: its last segment ${problem}`,
    );
  }
  if (isOsTempDirectory(path)) {
    throw new Error(
      `remove-directory: refusing to remove ${JSON.stringify(path)}: it is the OS temp directory`,
    );
  }
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
