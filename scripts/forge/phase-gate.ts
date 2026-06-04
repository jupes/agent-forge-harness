#!/usr/bin/env bun
/**
 * phase-gate.ts — Forge pipeline phase gate.
 *
 * Validates that the artifacts a Forge phase depends on exist before the phase
 * starts, and records phase completion in `.tmp/work/forge-state.json`.
 *
 * Pure logic is exported (and unit-tested in phase-gate.test.ts); the CLI at the
 * bottom is the only part that touches the filesystem.
 *
 * CLI:
 *   bun run scripts/forge/phase-gate.ts <phase> --slug <slug>            # can I enter <phase>?
 *   bun run scripts/forge/phase-gate.ts <phase> --slug <slug> --write    # mark <phase> complete
 *     [--feature "title"] [--epic <beads-id>]
 *
 * Output is always a single JSON object: { ok, data, error }.
 * Exit code 0 when ok, 2 when not (so callers and hooks can gate on it).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";

export type ForgePhase = "research" | "plan" | "implement" | "ship";

export const FORGE_PHASES: readonly ForgePhase[] = [
  "research",
  "plan",
  "implement",
  "ship",
] as const;

export interface ForgeState {
  slug: string;
  feature?: string;
  /** The most recently completed (or active) phase. */
  phase: ForgePhase;
  /** Phases whose exit artifact has been validated. */
  completed: ForgePhase[];
  /** Beads epic id grouping the work, if any. */
  epic?: string;
  /** Map of phase -> repo-relative artifact path. */
  artifacts: Partial<Record<ForgePhase, string>>;
  /** Last phase announced by the Stop hook (noise control). */
  announcedPhase?: ForgePhase;
  updatedAt: string;
}

export interface GateResult<T = unknown> {
  ok: boolean;
  data: T | null;
  error: string | null;
}

export const FORGE_STATE_PATH = join(".tmp", "work", "forge-state.json");

export function isForgePhase(value: string): value is ForgePhase {
  return (FORGE_PHASES as readonly string[]).includes(value);
}

/** Repo-relative path of the document a phase produces, or null if it has none. */
export function artifactPath(phase: ForgePhase, slug: string): string | null {
  switch (phase) {
    case "research":
      return `plans/research/${slug}.md`;
    case "plan":
      return `plans/drafts/${slug}.md`;
    case "implement":
      // Implementation has no single doc artifact — it is tracked by Beads + git.
      return null;
    case "ship":
      return `reports/${slug}-ship.md`;
  }
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
  extra: { feature?: string; epic?: string } = {},
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

  if (base.slug !== slug) {
    return {
      ok: false,
      data: null,
      error: `Active forge run is for slug "${base.slug}", not "${slug}". Finish or remove ${FORGE_STATE_PATH} first.`,
    };
  }

  const completed = base.completed.includes(phase)
    ? base.completed
    : [...base.completed, phase];
  const artifacts = { ...base.artifacts };
  if (ap !== null) artifacts[phase] = ap;

  const feature = extra.feature ?? base.feature;
  const epic = extra.epic ?? base.epic;
  const newState: ForgeState = {
    slug,
    phase,
    completed,
    artifacts,
    ...(feature ? { feature } : {}),
    ...(epic ? { epic } : {}),
    ...(base.announcedPhase ? { announcedPhase: base.announcedPhase } : {}),
    updatedAt: now(),
  };
  return { ok: true, data: newState, error: null };
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

// ── CLI ──────────────────────────────────────────────────────────────────────

function loadStateFromDisk(): ForgeState | null {
  if (!existsSync(FORGE_STATE_PATH)) return null;
  try {
    return parseState(readFileSync(FORGE_STATE_PATH, "utf8"));
  } catch {
    return null;
  }
}

function writeStateToDisk(state: ForgeState): void {
  mkdirSync(dirname(FORGE_STATE_PATH), { recursive: true });
  writeFileSync(FORGE_STATE_PATH, `${JSON.stringify(state, null, 2)}\n`);
}

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

  const write = argv.includes("--write");
  const state = loadStateFromDisk();

  if (write) {
    const feature = getFlag(argv, "feature");
    const epic = getFlag(argv, "epic");
    const result = recordComplete(phase, slugValue, existsSync, state, {
      ...(feature ? { feature } : {}),
      ...(epic ? { epic } : {}),
    });
    if (result.ok && result.data) writeStateToDisk(result.data);
    emit(result);
  } else {
    emit(validateEnter(phase, slugValue, existsSync, state));
  }
}
