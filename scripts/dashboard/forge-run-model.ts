/**
 * What the Forge run view shows, derived from local harness state.
 *
 * Pure functions — the plugin that reads the files lives in
 * `scripts/dashboard/dev-api.ts`, so the shape of the view is testable without
 * a filesystem or a server.
 */

import type { WorktreeRecord } from "../../types/beads";
import {
  artifactPath,
  FORGE_PHASES,
  type ForgePhase,
  type ForgeState,
} from "../forge/phases";

export type PhaseState = "complete" | "active" | "locked";

export interface PhaseRow {
  id: ForgePhase;
  state: PhaseState;
  /** Repo-relative artifact this phase produces, if it has one. */
  artifact: string | null;
  /** True when the phase claims an artifact that is not on disk. */
  artifactMissing: boolean;
}

export interface ForgeRunSnapshot {
  slug: string | null;
  feature: string | null;
  epic: string | null;
  updatedAt: string | null;
  phases: PhaseRow[];
  worktrees: WorktreeRecord[];
}

/**
 * The four pipeline phases with their status.
 *
 * A phase is complete when the run recorded it, active when it is the phase
 * the run is sitting in, and locked otherwise. A finished run (ship recorded)
 * has no active phase.
 */
export function phaseRows(
  state: ForgeState | null,
  artifactExists: (path: string) => boolean = () => true,
): PhaseRow[] {
  // The active phase is the first one not yet recorded complete. Reading it
  // from `state.phase` instead would show the last *finished* phase as active
  // — the pipeline would look stuck one step behind where the work is.
  const active =
    state === null
      ? null
      : (FORGE_PHASES.find((phase) => !state.completed.includes(phase)) ??
        null);

  return FORGE_PHASES.map((phase) => {
    const completed = state?.completed.includes(phase) ?? false;
    const artifact = state?.slug ? artifactPath(phase, state.slug) : null;
    return {
      id: phase,
      state: completed ? "complete" : phase === active ? "active" : "locked",
      artifact,
      artifactMissing:
        completed && artifact !== null ? !artifactExists(artifact) : false,
    };
  });
}

/** Worktree records written by `scripts/worktree.ts`. */
export function parseWorktreeState(json: string | null): WorktreeRecord[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json) as { worktrees?: unknown };
    if (!Array.isArray(parsed.worktrees)) return [];
    return parsed.worktrees.filter((entry): entry is WorktreeRecord => {
      const record = entry as Partial<WorktreeRecord>;
      return (
        typeof record.id === "string" &&
        typeof record.path === "string" &&
        typeof record.branch === "string" &&
        typeof record.createdAt === "string"
      );
    });
  } catch {
    return [];
  }
}

function parseForgeState(json: string | null): ForgeState | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as Partial<ForgeState>;
    if (typeof parsed.slug !== "string" || typeof parsed.phase !== "string") {
      return null;
    }
    return {
      slug: parsed.slug,
      phase: parsed.phase as ForgePhase,
      completed: Array.isArray(parsed.completed)
        ? (parsed.completed as ForgePhase[])
        : [],
      artifacts: parsed.artifacts ?? {},
      ...(parsed.feature ? { feature: parsed.feature } : {}),
      ...(parsed.epic ? { epic: parsed.epic } : {}),
      updatedAt: parsed.updatedAt ?? "",
    };
  } catch {
    return null;
  }
}

export function forgeRunSnapshot(input: {
  stateJson: string | null;
  worktreeJson: string | null;
  artifactExists: (path: string) => boolean;
}): ForgeRunSnapshot {
  const state = parseForgeState(input.stateJson);
  return {
    slug: state?.slug ?? null,
    feature: state?.feature ?? null,
    epic: state?.epic ?? null,
    updatedAt: state?.updatedAt || null,
    phases: phaseRows(state, input.artifactExists),
    worktrees: parseWorktreeState(input.worktreeJson),
  };
}
