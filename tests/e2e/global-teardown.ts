import { rmSync } from "node:fs";
import { BD_STAND_IN_BIN, HEARTH_HOME, isRunHome } from "./servers";

/**
 * Remove this run's hearth home: a lock file, an operator token, the ledger
 * the hearth audits into, and the artifacts of the council run one spec starts.
 *
 * Best effort, and deliberately silent. Playwright calls this while the
 * servers are still up, and an error thrown here would turn a green run red
 * over a few files in the OS temp directory. It is not called at all when a
 * server fails to start, so that case leaves the directory behind. On Windows
 * the hearth still holds its ledger open at this point, the removal fails, and
 * the directory is left for the OS as well.
 *
 * The stand-in for `bd` that global setup built there is removed first and on
 * its own: it is by far the largest thing in the home, nothing holds it open
 * once the tests are over, and it must not be what a failed removal leaves.
 */
export default function globalTeardown(): void {
  if (!isRunHome(HEARTH_HOME)) return;
  try {
    rmSync(BD_STAND_IN_BIN, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 100,
    });
  } catch {
    // Left for the OS to clear.
  }
  try {
    rmSync(HEARTH_HOME, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 100,
    });
  } catch {
    // Left for the OS to clear.
  }
}
