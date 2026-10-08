import { rmSync } from "node:fs";
import { HEARTH_HOME, isRunHome } from "./servers";

/**
 * Remove this run's hearth home: a lock file and an operator token.
 *
 * Best effort, and deliberately silent. Playwright calls this while the
 * servers are still up, and an error thrown here would turn a green run red
 * over a few bytes in the OS temp directory. It is not called at all when a
 * server fails to start, so that case leaves the directory behind.
 */
export default function globalTeardown(): void {
  if (!isRunHome(HEARTH_HOME)) return;
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
