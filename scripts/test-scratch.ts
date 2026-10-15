/**
 * Scratch directories for tests that need a real directory under the OS temp
 * directory, and take it away again.
 *
 * A suite makes its directories through `make`, and removes them in an
 * `afterEach` (or an `afterAll`, for one made when the file loads) with
 * `cleanup`. Only the exact paths it made are removed: never a pattern, never
 * a parent. A test that opens a ledger inside its directory closes that ledger
 * first, because Windows cannot remove an open file.
 */

import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

export interface ScratchDirs {
  /** A new directory under the OS temp directory, its name starting with `prefix`; `cleanup` removes it. */
  make(prefix: string): string;
  /** A directory something else made (a function under test): `cleanup` removes it too. Returns `dir`. */
  track(dir: string): string;
  /** Remove every directory made or tracked since the last call, each by its own path. */
  cleanup(): void;
}

export function scratchDirs(): ScratchDirs {
  const made: string[] = [];
  return {
    make(prefix) {
      const dir = mkdtempSync(join(tmpdir(), prefix));
      made.push(dir);
      return dir;
    },
    track(dir) {
      made.push(dir);
      return dir;
    },
    cleanup() {
      for (const dir of made.splice(0)) {
        rmSync(dir, {
          recursive: true,
          force: true,
          maxRetries: 5,
          retryDelay: 100,
        });
      }
    },
  };
}
