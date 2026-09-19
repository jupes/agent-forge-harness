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

import { nextPhase, phaseCommand } from "./phase-gate";
import {
  activeRuns,
  listRuns,
  type RunSummary,
  readRunState,
  removeRunState,
} from "./runs";

interface CliResult<T = unknown> {
  ok: boolean;
  data: T | null;
  error: string | null;
}

/** What a run looks like on one line of the table. */
export function runLine(run: RunSummary): string {
  const done = run.completed.join(" → ") || "none";
  const next = run.complete
    ? "shipped"
    : run.next
      ? phaseCommand(run.next, run.slug)
      : (nextPhase(run.phase) ?? "ship");
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
