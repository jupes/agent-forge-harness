#!/usr/bin/env bun
/**
 * forge-phase-gate.ts — Stop exit hook for the Forge pipeline.
 *
 * Fires when the agent stops. It is a no-op unless a Forge run is active
 * (`.tmp/work/forge-state.json` exists and ship is not yet complete). When a run
 * is active it prints a one-line reminder of the next phase command — but only
 * once per phase transition, so it never spams turn after turn.
 *
 * It is intentionally NON-blocking: it always exits 0 and never traps the agent.
 */

import { existsSync, readFileSync, writeFileSync } from "fs";
import {
  FORGE_STATE_PATH,
  isRunComplete,
  nextPhase,
  parseState,
  phaseCommand,
} from "../../scripts/forge/phase-gate";

function main(): void {
  if (!existsSync(FORGE_STATE_PATH)) return;

  let state = null;
  try {
    state = parseState(readFileSync(FORGE_STATE_PATH, "utf8"));
  } catch {
    return;
  }
  if (!state || isRunComplete(state)) return;

  // Only announce on a phase change to avoid per-turn noise.
  if (state.announcedPhase === state.phase) return;

  const next = nextPhase(state.phase);
  const hint = next
    ? `Next: ${phaseCommand(next, state.slug)} (or continue /forgemaster).`
    : "Run /forge-ship to finish.";
  console.log(
    `[forge] Run "${state.slug}" — completed: ${state.completed.join(" → ") || "none"}. ${hint}`,
  );

  try {
    writeFileSync(
      FORGE_STATE_PATH,
      `${JSON.stringify({ ...state, announcedPhase: state.phase }, null, 2)}\n`,
    );
  } catch {
    // Non-fatal: announcement de-duplication is best-effort.
  }
}

main();
process.exit(0);
