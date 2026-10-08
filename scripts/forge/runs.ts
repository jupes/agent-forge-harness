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
 * The filesystem wrappers live in `runs-store.ts`. For the same reason nothing
 * here imports the ledger, which only loads under Bun.
 */

import { validateExecutor } from "../hearth/validate";
import {
  FORGE_PHASES,
  type ForgeMode,
  type ForgePhase,
  type ForgeState,
  isForgeMode,
  isForgePhase,
  isReviewAction,
  isReviewStatus,
  type ReviewFindings,
  type ReviewRound,
} from "./phases";
import { reviewGate } from "./review-rules";

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

/**
 * A round as the state file holds it, keeping every field it carries. A stored
 * decision that is not one of the three actions is dropped — the field, not
 * the round — so the rules fall back to deriving it.
 */
function readRound(value: ReviewRound): ReviewRound {
  const { action, reason, ...rest } = value as Omit<
    ReviewRound,
    "action" | "reason"
  > & { action?: unknown; reason?: unknown };
  return {
    ...rest,
    ...(isReviewAction(action) ? { action } : {}),
    ...(typeof reason === "string" ? { reason } : {}),
  };
}

/**
 * Parse forge state JSON; returns null on missing/invalid input.
 *
 * This is also the v1 → v2 migration: a file written before `schemaVersion`
 * existed is read with every field it has and comes back as version 2. The
 * file itself is rewritten only when the run next records something.
 */
export function parseState(text: string): ForgeState | null {
  try {
    const parsed = JSON.parse(text) as Partial<ForgeState>;
    // An executor is trusted only when it has the contract's shape.
    const executor = validateExecutor(parsed.executor);
    if (
      typeof parsed.slug === "string" &&
      typeof parsed.phase === "string" &&
      isForgePhase(parsed.phase) &&
      Array.isArray(parsed.completed)
    ) {
      return {
        schemaVersion: 2,
        slug: parsed.slug,
        phase: parsed.phase,
        completed: parsed.completed.filter(isForgePhase),
        artifacts: parsed.artifacts ?? {},
        ...(parsed.feature ? { feature: parsed.feature } : {}),
        ...(parsed.epic ? { epic: parsed.epic } : {}),
        ...(typeof parsed.beadId === "string" && parsed.beadId.length > 0
          ? { beadId: parsed.beadId }
          : {}),
        ...(executor.ok ? { executor: executor.value } : {}),
        ...(parsed.announcedPhase && isForgePhase(parsed.announcedPhase)
          ? { announcedPhase: parsed.announcedPhase }
          : {}),
        ...(isReviewStatus(parsed.announcedStatus)
          ? { announcedStatus: parsed.announcedStatus }
          : {}),
        ...(typeof parsed.mode === "string" && isForgeMode(parsed.mode)
          ? { mode: parsed.mode }
          : {}),
        ...(parsed.checkout ? { checkout: parsed.checkout } : {}),
        ...(Array.isArray(parsed.reviews)
          ? { reviews: parsed.reviews.filter(isReviewRound).map(readRound) }
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
  /**
   * What to do next: the first phase not yet complete, or — for an auto run —
   * the completed phase still waiting on a review or a revision. Null once
   * shipped, and null while the run is halted.
   */
  next: ForgePhase | null;
  /** Set when an auto run's review loop stopped it; nothing follows until a new round advances. */
  halted: { phase: ForgePhase; reason: string } | null;
  /** The completed phase an auto run still has to review (or revise and review again). */
  reviewPending: ForgePhase | null;
  complete: boolean;
  mode: ForgeMode;
  feature: string | null;
  epic: string | null;
  checkout: string | null;
  updatedAt: string;
}

export function summarizeRun(state: ForgeState): RunSummary {
  const gate = reviewGate(state);
  const firstIncomplete =
    FORGE_PHASES.find((phase) => !state.completed.includes(phase)) ?? null;
  return {
    slug: state.slug,
    phase: state.phase,
    completed: state.completed,
    next:
      gate.status === "halted"
        ? null
        : gate.status === "clear"
          ? firstIncomplete
          : gate.phase,
    halted:
      gate.status === "halted"
        ? { phase: gate.phase, reason: gate.reason }
        : null,
    reviewPending:
      gate.status === "awaiting-review" || gate.status === "revise"
        ? gate.phase
        : null,
    complete: isRunComplete(state),
    mode: state.mode ?? "gated",
    feature: state.feature ?? null,
    epic: state.epic ?? null,
    checkout: state.checkout ?? null,
    updatedAt: state.updatedAt,
  };
}

/**
 * The runs still in flight, in their original order. A run that recorded ship
 * but whose ship review halted or is still pending is not finished.
 */
export function activeRuns(runs: readonly RunSummary[]): RunSummary[] {
  return runs.filter(
    (run) => !run.complete || run.halted !== null || run.reviewPending !== null,
  );
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
