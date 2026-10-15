/**
 * Scratch directories for tests that need a real directory under the OS temp
 * directory, and take it away again.
 *
 * A suite makes its directories through `make`, and removes them in an
 * `afterEach` (or an `afterAll`, for one made when the file loads) with
 * `cleanup`. `cleanup` removes a whole tree, so what it removes is limited:
 * only the directories `make` made and the ones `track` was given, each by the
 * path stored when it was taken (the real path of its parent plus its own
 * name), never a pattern and never a parent. `track` throws, and tracks
 * nothing, for a path that is not a plain name directly under the OS temp
 * directory, compared by real path:
 *
 * - a relative path, a path outside the temp directory, one nested deeper, the
 *   temp directory itself (in any spelling), and one with a `.` or `..`
 *   segment;
 * - a last segment that is empty or ends in a dot or a space, and any segment
 *   made only of dots and spaces: Windows strips trailing dots and spaces, so
 *   `<temp>\...` or `<temp>\ ` would name the temp directory itself;
 * - a path that exists but resolves, through a link, to anything other than a
 *   directory directly under the temp directory.
 *
 * Not guaranteed: the check is made when the path is taken, not when `cleanup`
 * runs, so a directory swapped for a link in between is not caught; and what
 * is inside a taken directory is removed with it (a link inside is removed, not
 * followed, by `rmSync`; only junctions were tried, on Windows). The removal is
 * retried for a moment on a lock (`removeDirectory`). A test that opens a
 * ledger inside its directory closes that ledger first, because Windows cannot
 * remove an open file.
 */

import { mkdtempSync, realpathSync } from "fs";
import { tmpdir } from "os";
import { basename, dirname, isAbsolute, join } from "path";
import { nameProblem, removeDirectory } from "./remove-directory";

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
 * is known to be a plain name directly under the real temp directory. Throws
 * otherwise. What is checked, in order:
 *
 * - `dir` is absolute;
 * - its last segment is a name that is not empty and does not end in a dot or a
 *   space (`nameProblem`), so `<temp>\...` is never taken for the temp
 *   directory's child (Windows strips trailing dots and spaces);
 * - no other segment is made only of dots and spaces (`..`, `...`, ` `), which
 *   can name another directory too;
 * - the real path of its parent is the real path of the temp directory;
 * - when it exists, its own real path is directly under the temp directory too,
 *   so the temp directory itself, and a link that leads back to it or out of
 *   it, are refused.
 */
function underTemp(dir: string, tempDir: string): string {
  if (!isAbsolute(dir)) refuse(dir, "it is not an absolute path");
  const name = basename(dir);
  const problem = nameProblem(name);
  if (problem !== null) refuse(dir, `its last segment ${problem}`);
  if (dir.split(/[\\/]+/).some((part) => /^[. ]+$/.test(part))) {
    refuse(
      dir,
      "it has a segment made only of dots and spaces (. or .. or ...)",
    );
  }
  const temp = realpathSync.native(tempDir);
  const notUnder = `is not directly under the OS temp directory (${temp})`;
  let parent: string | null = null;
  try {
    parent = realpathSync.native(dirname(dir));
  } catch {
    parent = null;
  }
  if (parent === null || parent !== temp) refuse(dir, `it ${notUnder}`);
  const candidate = join(parent, name);
  let real: string | null = null;
  try {
    real = realpathSync.native(candidate);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTDIR") {
      refuse(dir, `its real path cannot be resolved (${String(code)})`);
    }
  }
  if (real !== null && dirname(real) !== temp) {
    refuse(dir, `it resolves to ${JSON.stringify(real)}, which ${notUnder}`);
  }
  return candidate;
}

/** A prefix is one name: no separator, not empty, not only dots. */
function assertPrefix(prefix: string): void {
  if (prefix === "" || /[\\/]/.test(prefix) || /^\.+$/.test(prefix)) {
    throw new Error(
      `test-scratch: refusing the prefix ${JSON.stringify(prefix)}: it must be a name, not a path`,
    );
  }
}

export interface ScratchOptions {
  /**
   * The directory scratch directories go in, and the only one `track` takes a
   * child of. Default: the OS temp directory, read at each call. A test of the
   * guard gives a directory of its own here, so that what it gets wrong is
   * removed from a fake temp directory and never from the real one.
   */
  tempDir?: string;
}

export function scratchDirs(options: ScratchOptions = {}): ScratchDirs {
  const made: string[] = [];
  const temp = () => options.tempDir ?? tmpdir();
  return {
    make(prefix) {
      assertPrefix(prefix);
      const dir = mkdtempSync(join(temp(), prefix));
      made.push(underTemp(dir, temp()));
      return dir;
    },
    track(dir) {
      made.push(underTemp(dir, temp()));
      return dir;
    },
    cleanup() {
      for (const dir of made.splice(0)) removeDirectory(dir);
    },
  };
}
