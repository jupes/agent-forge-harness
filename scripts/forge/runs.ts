/**
 * The registry of Forge runs — the pure half.
 *
 * Every run owns one state file — `.tmp/work/forge-runs/<slug>.json` — so two
 * features can be in flight at the same time without overwriting each other.
 * The pipeline used to keep a single `.tmp/work/forge-state.json`; that file is
 * migrated into the per-run layout the first time the registry is read, so a
 * run that was mid-pipeline when the harness changed is not stranded.
 *
 * Nothing here touches disk or imports a Node built-in: the dashboard bundles
 * this module into the browser, so a stray `fs`/`path` import breaks the build.
 * The filesystem wrappers live in `runs-store.ts`.
 */

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
export const FORGE_RUNS_DIR = ".tmp/work/forge-runs";

/** The single-run state file the pipeline kept before runs became concurrent. */
export const LEGACY_STATE_PATH = ".tmp/work/forge-state.json";

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
  return isValidSlug(slug) ? `${FORGE_RUNS_DIR}/${slug}.json` : null;
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
