#!/usr/bin/env bun
/**
 * forge-phase-gate.ts — Stop exit hook for the Forge pipeline.
 *
 * Fires when the agent stops. It is a no-op unless at least one Forge run is in
 * flight (a state file under `.tmp/work/forge-runs/` whose ship phase is not
 * recorded). For each such run it prints a one-line reminder of the next phase
 * command — but only once per run per phase transition, so several concurrent
 * runs never spam turn after turn.
 *
 * It is intentionally NON-blocking: it always exits 0 and never traps the agent.
 */

import { nextPhase, phaseCommand } from "../../scripts/forge/phase-gate";
import {
  activeRuns,
  listRuns,
  type RunSummary,
  readRunState,
  writeRunState,
} from "../../scripts/forge/runs";

/** The reminder line for one run, or null when it was already announced. */
function announcement(run: RunSummary): string | null {
  const state = readRunState(run.slug);
  // Only announce on a phase change to avoid per-turn noise.
  if (state === null || state.announcedPhase === state.phase) return null;

  const next = nextPhase(run.phase);
  const resume =
    run.mode === "auto"
      ? `(or continue /forgemaster-auto ${run.slug})`
      : `(or continue /forgemaster ${run.slug})`;
  const hint = next
    ? `Next: ${phaseCommand(next, run.slug)} ${resume}.`
    : "Run /forge-ship to finish.";

  try {
    writeRunState({ ...state, announcedPhase: state.phase });
  } catch {
    // Non-fatal: announcement de-duplication is best-effort.
  }

  return `[forge] Run "${run.slug}" (${run.mode}) — completed: ${run.completed.join(" → ") || "none"}. ${hint}`;
}

function main(): void {
  let runs: RunSummary[] = [];
  try {
    runs = activeRuns(listRuns());
  } catch {
    return;
  }
  for (const run of runs) {
    const line = announcement(run);
    if (line !== null) console.log(line);
  }
}

main();
process.exit(0);
