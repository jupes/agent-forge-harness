/**
 * Scratch directories for tests that need a real directory under the OS temp
 * directory, and take it away again.
 *
 * A suite makes its directories through `make`, and removes them in an
 * `afterEach` (or an `afterAll`, for one made when the file loads) with
 * `cleanup`. `cleanup` removes a whole tree, so what it removes is limited: it
 * takes only the directories `make` made and the ones `track` was given, and
 * `track` refuses (throws) any path that is not an absolute path directly under
 * the OS temp directory, compared by real path. A relative path, the temp
 * directory itself, a path outside it, one nested deeper, or one with a `.`
 * or `..` segment is never removed. The removal is by the exact path, never a
 * pattern and never a parent, and it is retried for a moment on a lock
 * (`removeDirectory`). A test that opens a ledger inside its directory closes
 * that ledger first, because Windows cannot remove an open file.
 */

import { mkdtempSync, realpathSync } from "fs";
import { tmpdir } from "os";
import { basename, dirname, isAbsolute, join } from "path";
import { removeDirectory } from "./remove-directory";

export interface ScratchDirs {
  /**
   * A new directory under the OS temp directory, its name starting with
   * `prefix` (a name, not a path); `cleanup` removes it.
   */
  make(prefix: string): string;
  /**
   * A directory something else made (a function under test): `cleanup` removes
   * it too. Returns `dir`. Throws, and tracks nothing, unless `dir` is an
   * absolute path directly under the OS temp directory.
   */
  track(dir: string): string;
  /** Remove every directory made or tracked since the last call, each by its own path. */
  cleanup(): void;
}

function refuse(dir: string, reason: string): never {
  throw new Error(
    `test-scratch: refusing to track ${JSON.stringify(dir)}: ${reason}`,
  );
}

/**
 * The path to remove for `dir`: its real parent plus its own name, once `dir`
 * is known to be directly under the real OS temp directory. Throws otherwise.
 */
function underTemp(dir: string): string {
  if (!isAbsolute(dir)) refuse(dir, "it is not an absolute path");
  if (dir.split(/[\\/]+/).some((part) => part === "." || part === "..")) {
    refuse(dir, "it has a . or .. segment");
  }
  const name = basename(dir);
  const temp = realpathSync.native(tmpdir());
  let parent: string | null = null;
  try {
    parent = realpathSync.native(dirname(dir));
  } catch {
    parent = null;
  }
  if (name === "" || parent === null || parent !== temp) {
    refuse(dir, `it is not directly under the OS temp directory (${temp})`);
  }
  return join(parent, name);
}

/** A prefix is one name: no separator, not empty, not only dots. */
function assertPrefix(prefix: string): void {
  if (prefix === "" || /[\\/]/.test(prefix) || /^\.+$/.test(prefix)) {
    throw new Error(
      `test-scratch: refusing the prefix ${JSON.stringify(prefix)}: it must be a name, not a path`,
    );
  }
}

export function scratchDirs(): ScratchDirs {
  const made: string[] = [];
  return {
    make(prefix) {
      assertPrefix(prefix);
      const dir = mkdtempSync(join(tmpdir(), prefix));
      made.push(underTemp(dir));
      return dir;
    },
    track(dir) {
      made.push(underTemp(dir));
      return dir;
    },
    cleanup() {
      for (const dir of made.splice(0)) removeDirectory(dir);
    },
  };
}
