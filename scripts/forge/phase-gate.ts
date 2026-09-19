#!/usr/bin/env bun
/**
 * phase-gate.ts — Forge pipeline phase gate.
 *
 * Validates that the artifacts a Forge phase depends on exist before the phase
 * starts, and records phase completion in that run's own state file
 * (`.tmp/work/forge-runs/<slug>.json` — see `runs.ts`). State is per-run, so
 * several features can be in flight at the same time.
 *
 * Pure logic is exported (and unit-tested in phase-gate.test.ts); the CLI at the
 * bottom is the only part that touches the filesystem.
 *
 * CLI:
 *   bun run scripts/forge/phase-gate.ts <phase> --slug <slug>            # can I enter <phase>?
 *   bun run scripts/forge/phase-gate.ts <phase> --slug <slug> --write    # mark <phase> complete
 *     [--feature "title"] [--epic <beads-id>] [--mode gated|auto] [--checkout <path>]
 *
 * Output is always a single JSON object: { ok, data, error }.
 * Exit code 0 when ok, 2 when not (so callers and hooks can gate on it).
 */

import { existsSync } from "fs";

import {
  artifactPath,
  FORGE_PHASES,
  type ForgeMode,
  type ForgePhase,
  type ForgeState,
  isForgeMode,
  isForgePhase,
} from "./phases";
import {
  isRunComplete,
  isValidSlug,
  migrateLegacyRun,
  parseState,
  readRunState,
  runStatePath,
  writeRunState,
} from "./runs";

/** Re-exported so callers have one import for a run's state and its gate. */
export {
  artifactPath,
  FORGE_PHASES,
  type ForgePhase,
  type ForgeState,
  isForgePhase,
  isRunComplete,
  parseState,
  runStatePath,
};

export interface GateResult<T = unknown> {
  ok: boolean;
  data: T | null;
  error: string | null;
}

/** The phase that must be complete before `phase` may start. */
export function prereqPhase(phase: ForgePhase): ForgePhase | null {
  const idx = FORGE_PHASES.indexOf(phase);
  return idx <= 0 ? null : (FORGE_PHASES[idx - 1] ?? null);
}

/** The phase that follows `phase`, or null if `phase` is the last one. */
export function nextPhase(phase: ForgePhase): ForgePhase | null {
  const idx = FORGE_PHASES.indexOf(phase);
  return idx < 0 || idx >= FORGE_PHASES.length - 1
    ? null
    : (FORGE_PHASES[idx + 1] ?? null);
}

/** The slash command that runs a phase. */
export function phaseCommand(phase: ForgePhase, slug: string): string {
  return `/forge-${phase} ${slug}`;
}

/**
 * Can `phase` start? Its prerequisite is satisfied when the prerequisite's
 * artifact exists, or (for artifact-less phases) state records it complete.
 */
export function validateEnter(
  phase: ForgePhase,
  slug: string,
  fileExists: (p: string) => boolean,
  state: ForgeState | null,
): GateResult<{ phase: ForgePhase; prereq: ForgePhase | null }> {
  const prereq = prereqPhase(phase);
  if (prereq === null) {
    return { ok: true, data: { phase, prereq }, error: null };
  }
  const ap = artifactPath(prereq, slug);
  const artifactPresent = ap !== null && fileExists(ap);
  const recorded = state?.completed.includes(prereq) ?? false;
  if (artifactPresent || recorded) {
    return { ok: true, data: { phase, prereq }, error: null };
  }
  const missing =
    ap !== null ? `missing artifact ${ap}` : "not recorded as complete";
  return {
    ok: false,
    data: null,
    error: `Cannot start "${phase}": prerequisite "${prereq}" is not complete (${missing}). Run ${phaseCommand(prereq, slug)} first.`,
  };
}

/**
 * Record `phase` complete. Requires the phase's own artifact to exist (when it
 * has one). Returns the new state to persist.
 */
export function recordComplete(
  phase: ForgePhase,
  slug: string,
  fileExists: (p: string) => boolean,
  state: ForgeState | null,
  extra: {
    feature?: string;
    epic?: string;
    mode?: ForgeMode;
    checkout?: string;
  } = {},
  now: () => string = () => new Date().toISOString(),
): GateResult<ForgeState> {
  const ap = artifactPath(phase, slug);
  if (ap !== null && !fileExists(ap)) {
    return {
      ok: false,
      data: null,
      error: `Cannot complete "${phase}": expected artifact ${ap} does not exist. Write it before advancing.`,
    };
  }

  const base: ForgeState = state ?? {
    slug,
    phase,
    completed: [],
    artifacts: {},
    updatedAt: now(),
  };

  // State is loaded by slug, so a mismatch means the file was hand-edited or
  // left by the older single-run layout. Refuse rather than merge two runs.
  if (base.slug !== slug) {
    return {
      ok: false,
      data: null,
      error: `State at ${runStatePath(slug) ?? slug} records slug "${base.slug}", not "${slug}". Fix or remove that file before advancing this run.`,
    };
  }

  const completed = base.completed.includes(phase)
    ? base.completed
    : [...base.completed, phase];
  const artifacts = { ...base.artifacts };
  if (ap !== null) artifacts[phase] = ap;

  const feature = extra.feature ?? base.feature;
  const epic = extra.epic ?? base.epic;
  const mode = extra.mode ?? base.mode;
  const checkout = extra.checkout ?? base.checkout;
  const newState: ForgeState = {
    slug,
    phase,
    completed,
    artifacts,
    ...(feature ? { feature } : {}),
    ...(epic ? { epic } : {}),
    ...(base.announcedPhase ? { announcedPhase: base.announcedPhase } : {}),
    ...(mode ? { mode } : {}),
    ...(checkout ? { checkout } : {}),
    // The review ledger is the audit trail for an unattended run — advancing a
    // phase must never be what erases it.
    ...(base.reviews ? { reviews: base.reviews } : {}),
    updatedAt: now(),
  };
  return { ok: true, data: newState, error: null };
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function getFlag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

function emit(result: GateResult): never {
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 2);
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const phaseArg = argv[0];

  if (!phaseArg || !isForgePhase(phaseArg)) {
    emit({
      ok: false,
      data: null,
      error: `First argument must be one of: ${FORGE_PHASES.join(", ")}.`,
    });
  }
  const phase = phaseArg as ForgePhase;

  const slug = getFlag(argv, "slug");
  if (!slug) {
    emit({ ok: false, data: null, error: "Missing required --slug <slug>." });
  }
  const slugValue = slug as string;
  if (!isValidSlug(slugValue)) {
    emit({
      ok: false,
      data: null,
      error: `Slug "${slugValue}" cannot name a run: start with a letter or digit, then letters, digits, dot, dash or underscore (80 max).`,
    });
  }

  const write = argv.includes("--write");
  // A run started before state went per-run keeps its history: move it into the
  // runs directory before reading, so resuming it does not start from scratch.
  migrateLegacyRun();
  const state = readRunState(slugValue);

  if (write) {
    const feature = getFlag(argv, "feature");
    const epic = getFlag(argv, "epic");
    const modeArg = getFlag(argv, "mode");
    const checkout = getFlag(argv, "checkout");
    if (modeArg !== undefined && !isForgeMode(modeArg)) {
      emit({
        ok: false,
        data: null,
        error: `--mode must be "gated" or "auto", not "${modeArg}".`,
      });
    }
    const result = recordComplete(phase, slugValue, existsSync, state, {
      ...(feature ? { feature } : {}),
      ...(epic ? { epic } : {}),
      ...(modeArg !== undefined && isForgeMode(modeArg)
        ? { mode: modeArg }
        : {}),
      ...(checkout ? { checkout } : {}),
    });
    if (result.ok && result.data) writeRunState(result.data);
    emit(result);
  } else {
    emit(validateEnter(phase, slugValue, existsSync, state));
  }
}
