#!/usr/bin/env bun
/**
 * runs-cli.ts — see and retire Forge runs.
 *
 * Runs are concurrent, so "what is in flight?" needs an answer that is not a
 * single state file. This is that answer, for a human reading a terminal and
 * for an agent reading JSON.
 *
 * CLI:
 *   bun run forge:runs                  # every run, newest first
 *   bun run forge:runs --active         # only runs that have not shipped
 *   bun run forge:runs show <slug>      # one run's full state
 *   bun run forge:runs remove <slug>    # delete a run's state file
 *   bun run forge:runs --json           # { ok, data, error } instead of a table
 *
 * Exit code 0 when ok, 2 when not.
 */

import { phaseCommand, reviewCommand } from "./phase-gate";
import type { ForgeState, ReviewStatus } from "./phases";
import { reviewGate } from "./review-rules";
import { activeRuns, type RunSummary } from "./runs";
import { listRuns, readRunState, removeRunState } from "./runs-store";

interface CliResult<T = unknown> {
  ok: boolean;
  data: T | null;
  error: string | null;
}

/**
 * What comes next for a run, in words. A halt outranks a pending review, which
 * outranks "shipped": a run is never offered the following phase's command
 * while its reviews hold it.
 */
function nextStep(run: RunSummary): string {
  if (run.halted !== null) {
    return `halted in ${run.halted.phase} — ${run.halted.reason}`;
  }
  if (run.reviewPending !== null) {
    return `review ${run.reviewPending} (${reviewCommand(run.reviewPending, run.slug)})`;
  }
  if (run.complete || run.next === null) return "shipped";
  return phaseCommand(run.next, run.slug);
}

/** The Stop hook's reminder line for a run: the halt or the pending review when there is one, else the next phase. */
export function stopAnnouncement(run: RunSummary): string {
  const done = run.completed.join(" → ") || "none";
  const head = `[forge] Run "${run.slug}" (${run.mode}) — completed: ${done}.`;
  if (run.halted !== null) {
    return `${head} HALTED in ${run.halted.phase}: ${run.halted.reason} Nothing advances until a new review of ${run.halted.phase} does (${reviewCommand(run.halted.phase, run.slug)}).`;
  }
  if (run.reviewPending !== null) {
    return `${head} Next: review ${run.reviewPending} (${reviewCommand(run.reviewPending, run.slug)}).`;
  }
  if (run.complete || run.next === null) return `${head} Shipped.`;
  const resume =
    run.mode === "auto"
      ? `(or continue /forgemaster-auto ${run.slug})`
      : `(or continue /forgemaster ${run.slug})`;
  return `${head} Next: ${phaseCommand(run.next, run.slug)} ${resume}.`;
}

/** The review status the Stop hook records beside the phase it announced. */
export function announcedStatusFor(state: ForgeState): ReviewStatus {
  return reviewGate(state).status;
}

/**
 * Should the Stop hook speak for this run? Once per change of phase or of
 * review status — so a halt that lands after the phase was announced is still
 * said once, and so is the review that later clears it. A state file from
 * before statuses were recorded counts as having announced "clear".
 */
export function shouldAnnounce(state: ForgeState): boolean {
  return (
    state.announcedPhase !== state.phase ||
    (state.announcedStatus ?? "clear") !== announcedStatusFor(state)
  );
}

/** What a run looks like on one line of the table. */
export function runLine(run: RunSummary): string {
  const done = run.completed.join(" → ") || "none";
  const next = nextStep(run);
  const where = run.checkout ? ` @ ${run.checkout}` : "";
  return `${run.slug} [${run.mode}]${where}\n    completed: ${done}\n    next: ${next}\n    updated: ${run.updatedAt}`;
}

function emit(result: CliResult, json: boolean, text?: string): never {
  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else if (result.ok) {
    console.log(text ?? "");
  } else {
    console.error(result.error);
  }
  process.exit(result.ok ? 0 : 2);
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const json = argv.includes("--json");
  const flags = new Set(argv.filter((a) => a.startsWith("--")));
  const positional = argv.filter((a) => !a.startsWith("--"));
  const command = positional[0] ?? "list";

  if (command === "show") {
    const slug = positional[1];
    if (!slug) {
      emit(
        { ok: false, data: null, error: "Usage: forge:runs show <slug>" },
        json,
      );
    }
    const state = readRunState(slug as string);
    if (state === null) {
      emit(
        { ok: false, data: null, error: `No forge run named "${slug}".` },
        json,
      );
    }
    emit(
      { ok: true, data: state, error: null },
      json,
      JSON.stringify(state, null, 2),
    );
  }

  if (command === "remove") {
    const slug = positional[1];
    if (!slug) {
      emit(
        { ok: false, data: null, error: "Usage: forge:runs remove <slug>" },
        json,
      );
    }
    const removed = removeRunState(slug as string);
    emit(
      removed
        ? { ok: true, data: { removed: slug }, error: null }
        : { ok: false, data: null, error: `No forge run named "${slug}".` },
      json,
      `Removed run "${slug}".`,
    );
  }

  if (command !== "list") {
    emit(
      {
        ok: false,
        data: null,
        error: `Unknown command "${command}". Use: list | show <slug> | remove <slug>.`,
      },
      json,
    );
  }

  const all = listRuns();
  const runs = flags.has("--active") ? activeRuns(all) : all;
  const heading =
    runs.length === 0
      ? "No forge runs. Start one with /forgemaster <feature>."
      : `${runs.length} forge run${runs.length === 1 ? "" : "s"}:\n\n${runs.map(runLine).join("\n\n")}`;
  emit({ ok: true, data: runs, error: null }, json, heading);
}
