#!/usr/bin/env bun
/**
 * forge-phase-gate.ts — Stop exit hook for the Forge pipeline.
 *
 * Fires when the agent stops. It is a no-op unless at least one Forge run is in
 * flight (a state file under `.tmp/work/forge-runs/` whose ship phase is not
 * recorded, or whose ship review halted). For each such run it prints a
 * one-line reminder — the next phase command, or the halt or pending review
 * that holds an auto run — but only once per run per change of phase or review
 * status, so several concurrent runs never spam turn after turn.
 *
 * It is intentionally NON-blocking: it always exits 0 and never traps the agent.
 */

import { activeRuns, type RunSummary } from "../../scripts/forge/runs";
import {
  announcedStatusFor,
  shouldAnnounce,
  stopAnnouncement,
} from "../../scripts/forge/runs-cli";
import {
  listRuns,
  readRunState,
  writeRunState,
} from "../../scripts/forge/runs-store";

/** The reminder line for one run, or null when it was already announced. */
function announcement(run: RunSummary): string | null {
  const state = readRunState(run.slug);
  // Only announce on a change of phase or review status to avoid per-turn noise.
  if (state === null || !shouldAnnounce(state)) return null;

  try {
    writeRunState({
      ...state,
      announcedPhase: state.phase,
      announcedStatus: announcedStatusFor(state),
    });
  } catch {
    // Non-fatal: announcement de-duplication is best-effort.
  }

  return stopAnnouncement(run);
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
