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
 *     [--bead <beads-id>] [--provider <id> --model <id> [--effort <level>] [--smith <name>]]
 *
 * An auto run cannot enter a phase while an earlier one is halted or still
 * waiting on its review (`reviewGate` in `review-rules.ts`). A successful entry
 * check and every `--write` are appended to the ledger (`forge:audit --run`).
 *
 * A `--write` for a run that names its bead (`--bead`, now or on an earlier
 * write) also writes the run's correlation (`scripts/run-correlation.ts`) and
 * prints it as `data.correlation`: its `pointer` is what the quality gate takes
 * as `--correlation`, in the checkout it names. The file goes in the checkout
 * the run recorded with `--checkout`, else the one this command ran in. Only a
 * `--bead` on this call rebinds a run; a run that names no bead prints
 * `correlation: null`. The epic is never used for this.
 *
 * Output is always a single JSON object: { ok, data, error }.
 * Exit code 0 when ok, 2 when not (so callers and hooks can gate on it).
 */

import { existsSync } from "fs";

import type { Executor } from "../../types/hearth";
import { validateExecutor } from "../hearth/validate";
import {
  artifactPath,
  FORGE_PHASES,
  type ForgeMode,
  type ForgePhase,
  type ForgeState,
  isForgeMode,
  isForgePhase,
} from "./phases";
import { reviewGate } from "./review-rules";
import { isRunComplete, isValidSlug, parseState, runStatePath } from "./runs";
import { migrateLegacyRun, readRunState, writeRunState } from "./runs-store";

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

/** The command that records a review round for a phase. */
export function reviewCommand(phase: ForgePhase, slug: string): string {
  return `bun run forge:review --slug ${slug} --phase ${phase} --verdict <path>`;
}

/**
 * Why an auto run may not start `phase` yet, or null when its reviews allow
 * it. Only a phase earlier than `phase` can hold it: re-running the held phase
 * itself is how the run gets moving again.
 */
function heldByReview(
  phase: ForgePhase,
  slug: string,
  state: ForgeState | null,
): string | null {
  if (state === null) return null;
  const gate = reviewGate(state);
  if (gate.status === "clear") return null;
  if (FORGE_PHASES.indexOf(gate.phase) >= FORGE_PHASES.indexOf(phase)) {
    return null;
  }
  const review = reviewCommand(gate.phase, slug);
  switch (gate.status) {
    case "halted":
      return `Cannot start "${phase}": "${gate.phase}" is halted — ${gate.reason} Fix the findings, re-run ${phaseCommand(gate.phase, slug)}, then record a review that advances: ${review}`;
    case "revise":
      return `Cannot start "${phase}": "${gate.phase}" is under revision — ${gate.reason} Revise it with ${phaseCommand(gate.phase, slug)}, then review again: ${review}`;
    case "awaiting-review":
      return `Cannot start "${phase}": "${gate.phase}" has not been reviewed, and an auto run does not advance a phase nobody reviewed. Record its review: ${review}`;
  }
}

/**
 * Can `phase` start? Its prerequisite is satisfied when the prerequisite's
 * artifact exists, or (for artifact-less phases) state records it complete —
 * and, for an auto run, no earlier phase is halted or waiting on a review.
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
    const held = heldByReview(phase, slug, state);
    if (held !== null) return { ok: false, data: null, error: held };
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
    beadId?: string;
    executor?: Executor;
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
  const beadId = extra.beadId ?? base.beadId;
  const executor = extra.executor ?? base.executor;
  const newState: ForgeState = {
    schemaVersion: 2,
    slug,
    phase,
    completed,
    artifacts,
    ...(feature ? { feature } : {}),
    ...(epic ? { epic } : {}),
    ...(beadId ? { beadId } : {}),
    ...(executor ? { executor } : {}),
    ...(base.announcedPhase ? { announcedPhase: base.announcedPhase } : {}),
    ...(base.announcedStatus ? { announcedStatus: base.announcedStatus } : {}),
    ...(mode ? { mode } : {}),
    ...(checkout ? { checkout } : {}),
    // The review ledger is the audit trail for an unattended run — advancing a
    // phase must never be what erases it. It is also where a halt lives, so
    // recording a phase cannot clear one.
    ...(base.reviews ? { reviews: base.reviews } : {}),
    updatedAt: now(),
  };
  return { ok: true, data: newState, error: null };
}

/**
 * The executor named by `--provider/--model [--effort] [--smith]`, or
 * undefined when none of the flags is given. Provider and model come together.
 */
export function executorFromFlags(flags: {
  provider?: string;
  model?: string;
  effort?: string;
  smith?: string;
}): GateResult<Executor | undefined> {
  const given = Object.values(flags).some((value) => value !== undefined);
  if (!given) return { ok: true, data: undefined, error: null };
  if (flags.provider === undefined || flags.model === undefined) {
    return {
      ok: false,
      data: null,
      error:
        "--provider and --model must be given together (--effort and --smith are optional extras).",
    };
  }
  const checked = validateExecutor({
    provider: flags.provider,
    model: flags.model,
    ...(flags.effort !== undefined ? { effort: flags.effort } : {}),
    ...(flags.smith !== undefined ? { smith: flags.smith } : {}),
  });
  return checked.ok
    ? { ok: true, data: checked.value, error: null }
    : { ok: false, data: null, error: checked.error };
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
  const bead = getFlag(argv, "bead");
  const provider = getFlag(argv, "provider");
  const model = getFlag(argv, "model");
  const effort = getFlag(argv, "effort");
  const smith = getFlag(argv, "smith");
  const flagged = executorFromFlags({
    ...(provider !== undefined ? { provider } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(effort !== undefined ? { effort } : {}),
    ...(smith !== undefined ? { smith } : {}),
  });
  if (!flagged.ok) emit(flagged);
  const explicit = {
    ...(bead ? { beadId: bead } : {}),
    ...(flagged.data ? { executor: flagged.data } : {}),
  };
  // Loaded here, not at the top: the ledger needs Bun's SQLite, and this
  // module's pure exports are imported by code that must load without it.
  const ledger = await import("./ledger-events");
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
      ...explicit,
    });
    if (!result.ok || !result.data) emit(result);
    const draft = result.data;
    const attach = ledger.attachRun({
      slug: slugValue,
      state: draft,
      explicit,
    });
    const executor = ledger.executorToPersist(
      attach,
      flagged.data ?? undefined,
      draft.executor,
    );
    const recorded: ForgeState = executor ? { ...draft, executor } : draft;
    writeRunState(recorded);
    ledger.emitRunEvent(
      attach,
      ledger.phaseCompleted(phase, recorded.artifacts[phase]),
    );
    // The launcher boundary: a run that names its bead gets a run correlation,
    // and the pointer to hand the quality gate is part of what this prints.
    const { correlateRun } = await import("../run-correlation-store");
    const correlated = correlateRun({
      // Where the run builds is where its gate runs: the checkout the run
      // recorded, which need not be the directory this command ran in.
      checkout: recorded.checkout ?? process.cwd(),
      topLevel: recorded.checkout !== undefined,
      executionRunId: slugValue,
      ...(bead ? { named: bead } : {}),
      ...(recorded.beadId ? { stored: recorded.beadId } : {}),
    });
    if (correlated.note) console.error(`forge:phase-gate: ${correlated.note}`);
    emit({
      ok: true,
      data: { ...recorded, correlation: correlated.correlation },
      error: null,
    });
  } else {
    const result = validateEnter(phase, slugValue, existsSync, state);
    if (result.ok) {
      ledger.emitPhaseEntered(
        ledger.attachRun({ slug: slugValue, state, explicit }),
        phase,
      );
    }
    emit(result);
  }
}
