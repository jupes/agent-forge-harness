/**
 * The registry of Forge runs.
 *
 * Every run owns one state file — `.tmp/work/forge-runs/<slug>.json` — so two
 * features can be in flight at the same time without overwriting each other.
 * The pipeline used to keep a single `.tmp/work/forge-state.json`; that file is
 * migrated into the per-run layout the first time the registry is read, so a
 * run that was mid-pipeline when the harness changed is not stranded.
 *
 * Pure logic is exported and unit-tested in `runs.test.ts`; the filesystem
 * wrappers at the bottom are the only part that touches disk.
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

import {
  FORGE_PHASES,
  type ForgeMode,
  type ForgePhase,
  type ForgeState,
  isForgeMode,
  isForgePhase,
  type ReviewFindings,
  type ReviewRound,
} from "./phases";

/** Repo-relative directory holding one state file per run. */
export const FORGE_RUNS_DIR = join(".tmp", "work", "forge-runs");

/** The single-run state file the pipeline kept before runs became concurrent. */
export const LEGACY_STATE_PATH = join(".tmp", "work", "forge-state.json");

/**
 * A slug becomes a filename, so it has to be one: alphanumeric start, then word
 * characters, dots, dashes and underscores. Anything with a separator or a `..`
 * is rejected rather than sanitized — a silently rewritten slug would split one
 * run across two state files.
 */
const SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;

export function isValidSlug(slug: string): boolean {
  return SLUG.test(slug) && !slug.includes("..");
}

/** Repo-relative state file for a run, or null when the slug is unusable. */
export function runStatePath(slug: string): string | null {
  return isValidSlug(slug) ? join(FORGE_RUNS_DIR, `${slug}.json`) : null;
}

/** The slug a runs-directory entry belongs to, or null if it is not a run file. */
export function runSlugFromFilename(name: string): string | null {
  if (!name.endsWith(".json")) return null;
  const slug = name.slice(0, -".json".length);
  return isValidSlug(slug) ? slug : null;
}

/** A review-ledger entry the state file can be trusted to hold. */
function isReviewRound(value: unknown): value is ReviewRound {
  const row = value as Partial<ReviewRound> | null;
  const findings = row?.findings as Partial<ReviewFindings> | undefined;
  return (
    typeof row === "object" &&
    row !== null &&
    typeof row.phase === "string" &&
    isForgePhase(row.phase) &&
    typeof row.round === "number" &&
    (row.verdict === "PASS" ||
      row.verdict === "FAIL" ||
      row.verdict === "UNREADABLE") &&
    typeof findings === "object" &&
    findings !== null &&
    typeof findings.blocker === "number" &&
    typeof findings.high === "number" &&
    typeof findings.medium === "number" &&
    typeof findings.low === "number"
  );
}

/** Parse forge state JSON; returns null on missing/invalid input. */
export function parseState(text: string): ForgeState | null {
  try {
    const parsed = JSON.parse(text) as Partial<ForgeState>;
    if (
      typeof parsed.slug === "string" &&
      typeof parsed.phase === "string" &&
      isForgePhase(parsed.phase) &&
      Array.isArray(parsed.completed)
    ) {
      return {
        slug: parsed.slug,
        phase: parsed.phase,
        completed: parsed.completed.filter(isForgePhase),
        artifacts: parsed.artifacts ?? {},
        ...(parsed.feature ? { feature: parsed.feature } : {}),
        ...(parsed.epic ? { epic: parsed.epic } : {}),
        ...(parsed.announcedPhase && isForgePhase(parsed.announcedPhase)
          ? { announcedPhase: parsed.announcedPhase }
          : {}),
        ...(typeof parsed.mode === "string" && isForgeMode(parsed.mode)
          ? { mode: parsed.mode }
          : {}),
        ...(parsed.checkout ? { checkout: parsed.checkout } : {}),
        ...(Array.isArray(parsed.reviews)
          ? { reviews: parsed.reviews.filter(isReviewRound) }
          : {}),
        updatedAt: parsed.updatedAt ?? new Date().toISOString(),
      };
    }
  } catch {
    // fall through
  }
  return null;
}

/** True once the ship phase is recorded complete. */
export function isRunComplete(state: ForgeState | null): boolean {
  return state?.completed.includes("ship") ?? false;
}

/** One run as the hooks, the CLI and the dashboard want to read it. */
export interface RunSummary {
  slug: string;
  /** The most recently completed (or active) phase, as the run recorded it. */
  phase: ForgePhase;
  completed: ForgePhase[];
  /** The first phase not yet complete — what to do next, or null once shipped. */
  next: ForgePhase | null;
  complete: boolean;
  mode: ForgeMode;
  feature: string | null;
  epic: string | null;
  checkout: string | null;
  updatedAt: string;
}

export function summarizeRun(state: ForgeState): RunSummary {
  return {
    slug: state.slug,
    phase: state.phase,
    completed: state.completed,
    next:
      FORGE_PHASES.find((phase) => !state.completed.includes(phase)) ?? null,
    complete: isRunComplete(state),
    mode: state.mode ?? "gated",
    feature: state.feature ?? null,
    epic: state.epic ?? null,
    checkout: state.checkout ?? null,
    updatedAt: state.updatedAt,
  };
}

/** The runs still in flight, in their original order. */
export function activeRuns(runs: readonly RunSummary[]): RunSummary[] {
  return runs.filter((run) => !run.complete);
}

/** Newest first, by the time the run last wrote state. Does not mutate `runs`. */
export function byRecency(runs: readonly RunSummary[]): RunSummary[] {
  return [...runs].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/**
 * A checkout path in comparable form. Git reports `C:/Users/...` where Node
 * reports `C:\Users\...`, and Windows drive paths compare case-insensitively.
 */
export function comparableCheckout(path: string): string {
  const slashed = path.trim().replaceAll("\\", "/").replace(/\/+$/, "");
  return /^[a-z]:\//i.test(slashed) ? slashed.toLowerCase() : slashed;
}

/**
 * What to write when a legacy single-run state file is found, or null when
 * there is nothing to move. An existing per-run file always wins: the legacy
 * file may be a stale leftover, and losing live state is the worse failure.
 */
export function legacyMigration(input: {
  legacyJson: string | null;
  runExists: (slug: string) => boolean;
}): { slug: string; state: ForgeState } | null {
  if (input.legacyJson === null) return null;
  const state = parseState(input.legacyJson);
  if (state === null || !isValidSlug(state.slug)) return null;
  if (input.runExists(state.slug)) return null;
  return { slug: state.slug, state };
}

// ── Filesystem ───────────────────────────────────────────────────────────────

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
