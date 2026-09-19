/**
 * The registry of Forge runs — the filesystem half.
 *
 * Reads and writes `.tmp/work/forge-runs/<slug>.json`, and migrates a legacy
 * single-run `forge-state.json` into that layout on the way past.
 *
 * Split from `runs.ts` because the dashboard bundles the pure half into the
 * browser: an `fs` or `path` import reachable from `forge-run-model.ts` fails
 * the Vite build. Anything that touches disk belongs here, and only Node-side
 * callers (the gate CLIs, the hooks, the dev API) import it.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { join } from "path";

import type { ForgeState } from "./phases";
import {
  byRecency,
  FORGE_RUNS_DIR,
  LEGACY_STATE_PATH,
  legacyMigration,
  parseState,
  type RunSummary,
  runSlugFromFilename,
  runStatePath,
  summarizeRun,
} from "./runs";

function runsDir(root: string): string {
  return join(root, FORGE_RUNS_DIR);
}

function absoluteRunPath(root: string, slug: string): string | null {
  const relative = runStatePath(slug);
  return relative === null ? null : join(root, relative);
}

export function readRunState(
  slug: string,
  root: string = process.cwd(),
): ForgeState | null {
  const path = absoluteRunPath(root, slug);
  if (path === null || !existsSync(path)) return null;
  try {
    return parseState(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

export function writeRunState(
  state: ForgeState,
  root: string = process.cwd(),
): boolean {
  const path = absoluteRunPath(root, state.slug);
  if (path === null) return false;
  mkdirSync(runsDir(root), { recursive: true });
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`);
  return true;
}

/** Delete a run's state file. Returns false when there was nothing to delete. */
export function removeRunState(
  slug: string,
  root: string = process.cwd(),
): boolean {
  const path = absoluteRunPath(root, slug);
  if (path === null || !existsSync(path)) return false;
  rmSync(path);
  return true;
}

/**
 * Move a legacy `.tmp/work/forge-state.json` into the per-run layout. Returns
 * the slug that was migrated, or null when there was nothing to migrate.
 */
export function migrateLegacyRun(root: string = process.cwd()): string | null {
  const legacyPath = join(root, LEGACY_STATE_PATH);
  if (!existsSync(legacyPath)) return null;
  let legacyJson: string | null = null;
  try {
    legacyJson = readFileSync(legacyPath, "utf8");
  } catch {
    return null;
  }
  const move = legacyMigration({
    legacyJson,
    runExists: (slug) => {
      const path = absoluteRunPath(root, slug);
      return path !== null && existsSync(path);
    },
  });
  if (move === null) return null;
  if (!writeRunState(move.state, root)) return null;
  try {
    rmSync(legacyPath);
  } catch {
    // Non-fatal: the per-run file is authoritative from here on.
  }
  return move.slug;
}

/**
 * Every run the harness knows about, newest first. Migrates a legacy state file
 * first so an in-flight run from before this layout still shows up.
 */
export function listRuns(root: string = process.cwd()): RunSummary[] {
  migrateLegacyRun(root);
  const dir = runsDir(root);
  if (!existsSync(dir)) return [];
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const runs: RunSummary[] = [];
  for (const entry of entries) {
    const slug = runSlugFromFilename(entry);
    if (slug === null) continue;
    const state = readRunState(slug, root);
    if (state !== null) runs.push(summarizeRun(state));
  }
  return byRecency(runs);
}
