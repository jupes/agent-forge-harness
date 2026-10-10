import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join, resolve } from "node:path";

/**
 * The two servers the suite runs against: where they listen and where the
 * hearth keeps its state. Shared by the Playwright config that starts them,
 * the teardown that cleans up, and the spec that checks they are the ones
 * answering.
 */

/** Dashboard dev server. `PORT` overrides it, as it does for `bun run dashboard`. */
export const DASHBOARD_PORT = Number(process.env["PORT"] ?? 8799);

/**
 * The hearth the suite starts. A fixed port, unlike a supervised hearth's
 * OS-chosen one, so the config can wait on it and a spec can ask it who it is.
 */
export const HEARTH_PORT = Number(process.env["E2E_HEARTH_PORT"] ?? 8798);

export const DASHBOARD_URL = `http://127.0.0.1:${DASHBOARD_PORT}`;
export const HEARTH_URL = `http://127.0.0.1:${HEARTH_PORT}`;

const RUN_HOME_NAME = /^agent-forge-e2e-\d+-\d+$/;

/**
 * A hearth home that exists for this run only.
 *
 * Playwright kills its servers outright, so a hearth never gets to release its
 * lock, and a hearth started directly takes any lock whose pid is alive at its
 * word and exits as "already running". A home shared between runs would
 * therefore stop the suite from starting whenever an old lock's pid had been
 * reused. A new home cannot hold an old lock. It also keeps the suite off the
 * developer's real `~/.agent-forge`.
 *
 * The runner picks the path once; workers evaluate this module again and must
 * arrive at the same one, so it travels in the environment. It is not created
 * here — list mode and every worker would each leave one behind. The hearth
 * creates it.
 *
 * `||=`, not `??=`: an empty value must count as unset, because the hearth
 * reads an empty `AGENT_FORGE_HOME` as "use the real one".
 */
export const HEARTH_HOME = (process.env["AGENT_FORGE_E2E_HOME"] ||= join(
  tmpdir(),
  `agent-forge-e2e-${process.pid}-${Date.now()}`,
));

/**
 * Whether `path` has the shape of a home this module generates: the only kind
 * the teardown may delete. It goes by shape alone, so any other place
 * `AGENT_FORGE_E2E_HOME` points at is used and left alone — and one that has
 * this shape is deleted, whoever chose it.
 */
export function isRunHome(path: string): boolean {
  return (
    resolve(dirname(path)) === resolve(tmpdir()) &&
    RUN_HOME_NAME.test(basename(path))
  );
}

// ── The stand-in for `bd` ───────────────────────────────────────────────────

/**
 * The suite never reaches a tracker. Both servers are started with a PATH that
 * holds the directory of a recording stand-in for `bd` (`bd-stand-in.ts`,
 * compiled by global setup), and almost nothing else:
 *
 * - the hearth: that directory only. `bd` is what a hearth runs for a write,
 *   so without the stand-in a write fails instead of reaching a tracker;
 * - the dashboard: that directory first, then node's, which Vite's launcher
 *   needs. A hearth the dashboard starts in place of the suite's inherits
 *   this PATH and finds the stand-in first.
 *
 * Both are therefore started by bun's absolute path. The stand-in and what it
 * records live in the run's home.
 */
export const BD_STAND_IN_BIN = join(HEARTH_HOME, "bd-stand-in", "bin");
export const BD_STAND_IN_STATE = join(HEARTH_HOME, "bd-stand-in", "state");
/** Relative to the checkout, which is where the runner and its servers run. */
export const BD_STAND_IN_SOURCE = join("tests", "e2e", "bd-stand-in.ts");

/** The environment's own name for PATH: `Path` on Windows under node. */
const PATH_KEY =
  Object.keys(process.env).find((name) => name.toUpperCase() === "PATH") ??
  "PATH";

/** The directory of the node that runs this suite: the one Vite will run under. */
export const NODE_DIR = dirname(process.execPath);

/** The absolute path of the bun on the runner's PATH. */
export function bunPath(): string {
  const file = process.platform === "win32" ? "bun.exe" : "bun";
  for (const directory of (process.env[PATH_KEY] ?? "").split(delimiter)) {
    if (directory && existsSync(join(directory, file)))
      return join(directory, file);
  }
  throw new Error(
    "bun is not on PATH: the browser suite starts its servers with it",
  );
}

/** Every spelling under which a directory can hold a `bd` a process would run. */
const BD_FILES = ["bd", "bd.exe", "bd.cmd", "bd.bat", "bd.ps1", "bd.bunx"];

/** The first `bd` found in `directories`, or null. */
export function findBd(directories: readonly string[]): string | null {
  for (const directory of directories)
    for (const file of BD_FILES)
      if (existsSync(join(directory, file))) return join(directory, file);
  return null;
}

/**
 * The directories besides the stand-in's that end up on the dashboard's PATH:
 * node's, and every `node_modules/.bin` from the checkout to the root of the
 * drive, which `bun run` puts there itself.
 */
export function dashboardPathDirectories(checkout: string): string[] {
  const directories = [NODE_DIR];
  for (let at = resolve(checkout); ; at = dirname(at)) {
    directories.push(join(at, "node_modules", ".bin"));
    if (dirname(at) === at) break;
  }
  return directories;
}

/**
 * Stop before anything starts when a real `bd` sits where the dashboard, or a
 * hearth it starts, could find it should the stand-in ever be missing.
 */
export function refuseAReachableBd(directories: readonly string[]): void {
  const found = findBd(directories);
  if (found !== null)
    throw new Error(
      `The browser suite will not start: ${found} is on the PATH its dashboard runs with, so a control plane the dashboard starts could run it against a real tracker. Run the suite with a node whose directory holds no bd.`,
    );
}

/** The PATH a server of the suite is given, and where the stand-in records. */
export function standInEnvironment(
  besides: readonly string[] = [],
): Record<string, string> {
  return {
    [PATH_KEY]: [BD_STAND_IN_BIN, ...besides].join(delimiter),
    BD_STAND_IN_STATE,
  };
}
