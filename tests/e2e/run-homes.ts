import { readdirSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { isPidAlive, readLock } from "../../scripts/hearth/lock";

/**
 * The hearth homes the suite generates, one per run, and the sweep that
 * removes the ones earlier runs left (agent-forge-harness-x1gs.3.9).
 *
 * Kept apart from `servers.ts`, which picks this run's home when it is loaded,
 * so the unit tests in `scripts/` can import it without choosing one.
 */

/** A generated home's name: the pid of the runner that chose it, and the time. */
export const RUN_HOME_NAME = /^agent-forge-e2e-(\d+)-\d+$/;

/** A hearth lock's file name (`lockPath` in `scripts/hearth/home.ts`). */
const LOCK_FILE = /^hearth-.*\.lock$/;

export interface SweepDeps {
  /** Whether a process with this pid is running. */
  alive?: (pid: number) => boolean;
  /** Remove a home; throws when it cannot. */
  remove?: (path: string) => void;
}

/** Whether a hearth lock in `home` names a process that is still running. */
function hearthRunsIn(home: string, alive: (pid: number) => boolean): boolean {
  let names: string[];
  try {
    names = readdirSync(home);
  } catch {
    return false;
  }
  return names.some((name) => {
    if (!LOCK_FILE.test(name)) return false;
    const lock = readLock(join(home, name));
    return lock !== null && alive(lock.pid);
  });
}

const removeHome = (path: string): void =>
  rmSync(path, {
    recursive: true,
    force: true,
    maxRetries: 3,
    retryDelay: 100,
  });

/**
 * Remove every generated home in `tempDir` that belongs to a finished run: not
 * `current`, its runner (the pid in its name) not running, and no hearth lock
 * in it naming a running process. A home whose runner or hearth is alive may
 * belong to a run in progress, in this checkout or another, and is left.
 *
 * On Windows a run's own teardown cannot remove its home: Playwright runs the
 * teardown while the hearth still holds its ledger open. The next run's
 * global setup removes it here instead.
 *
 * Best effort: a home that cannot be removed is left for a later run, and a
 * temp directory that cannot be read sweeps nothing. Returns what it removed.
 */
export function sweepFinishedRunHomes(
  current: string,
  tempDir: string,
  deps: SweepDeps = {},
): string[] {
  const alive = deps.alive ?? isPidAlive;
  const remove = deps.remove ?? removeHome;
  let names: string[];
  try {
    names = readdirSync(tempDir);
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const name of names) {
    const match = RUN_HOME_NAME.exec(name);
    if (match === null) continue;
    const path = join(tempDir, name);
    if (resolve(path) === resolve(current)) continue;
    try {
      if (!statSync(path).isDirectory()) continue;
    } catch {
      continue;
    }
    if (alive(Number(match[1])) || hearthRunsIn(path, alive)) continue;
    try {
      remove(path);
      removed.push(path);
    } catch {
      // Held open by something: left for a later run.
    }
  }
  return removed;
}
