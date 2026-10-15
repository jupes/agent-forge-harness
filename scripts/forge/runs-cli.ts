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
 * The command line is read strictly (`parseRunsArgs`): an unknown flag, a flag
 * given twice and a word the command does not use are refused before anything
 * is listed or removed.
 *
 * Exit code 0 when ok, 2 when not.
 */

import { isMain } from "../is-main";
import { phaseCommand, reviewCommand } from "./phase-gate";
import type { ForgePhase, ForgeState, ReviewStatus } from "./phases";
import { reviewGate } from "./review-rules";
import { activeRuns, type RunSummary } from "./runs";
import { listRuns, readRunState, removeRunState } from "./runs-store";

interface CliResult<T = unknown> {
  ok: boolean;
  data: T | null;
  error: string | null;
}

/**
 * What a run held by its reviews has to do: record the review it is waiting
 * on, or — when the last review asked for changes — revise first.
 */
function pendingStep(run: RunSummary, phase: ForgePhase): string {
  const command = reviewCommand(phase, run.slug);
  return run.revising
    ? `revise ${phase}, then record a review (${command})`
    : `review ${phase} (${command})`;
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
    return pendingStep(run, run.reviewPending);
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
    return `${head} Next: ${pendingStep(run, run.reviewPending)}.`;
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

const COMMANDS = ["list", "show", "remove"] as const;

type RunsCommand = (typeof COMMANDS)[number];

const isCommand = (word: string): word is RunsCommand =>
  (COMMANDS as readonly string[]).includes(word);

export interface RunsArgs {
  command: RunsCommand;
  /** The run `show` or `remove` names. */
  slug?: string;
  /** `--active`: list only the runs that have not shipped. */
  active: boolean;
  /** `--json`: print `{ ok, data, error }` instead of text. */
  json: boolean;
}

/** The flags, none of which takes a value. */
const SWITCHES = ["active", "json"] as const;

const isSwitch = (name: string): name is (typeof SWITCHES)[number] =>
  (SWITCHES as readonly string[]).includes(name);

/**
 * The command line, read strictly: the two switches anywhere, then the
 * command and the run it names. A flag that is unknown, given twice or given a
 * value is refused, and so is a word the command does not use and `--active`
 * on a command that is not `list`: a mistyped filter must not list every run,
 * and a slip after `remove <slug>` must not remove one.
 */
export function parseRunsArgs(
  argv: readonly string[],
):
  | { ok: true; data: RunsArgs; error: null }
  | { ok: false; data: null; error: string } {
  const refuse = (error: string) => ({ ok: false, data: null, error }) as const;
  const seen = new Set<string>();
  const words: string[] = [];
  for (const word of argv) {
    if (!word.startsWith("--")) {
      words.push(word);
      continue;
    }
    const equals = word.indexOf("=");
    const name = word.slice(2, equals < 0 ? undefined : equals);
    if (!isSwitch(name)) {
      return refuse(
        `unknown flag --${name}. Known flags: ${SWITCHES.map((flag) => `--${flag}`).join(", ")}.`,
      );
    }
    if (seen.has(name)) return refuse(`--${name} is given twice.`);
    if (equals >= 0) return refuse(`--${name} takes no value.`);
    seen.add(name);
  }
  const active = seen.has("active");
  const json = seen.has("json");

  const [command = "list", ...rest] = words;
  if (!isCommand(command)) {
    return refuse(
      `Unknown command "${command}". Use: list | show <slug> | remove <slug>.`,
    );
  }
  if (command === "list") {
    if (rest[0] !== undefined) {
      return refuse(`unexpected argument "${rest[0]}": list takes no run.`);
    }
    return { ok: true, data: { command, active, json }, error: null };
  }
  const [slug, extra] = rest;
  if (!slug) return refuse(`Usage: forge:runs ${command} <slug>`);
  if (extra !== undefined) {
    return refuse(`unexpected argument "${extra}": ${command} takes one run.`);
  }
  if (active) {
    return refuse(`--active filters list; ${command} does not use it.`);
  }
  return { ok: true, data: { command, slug, active, json }, error: null };
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

if (isMain(import.meta)) {
  const argv = process.argv.slice(2);
  const parsed = parseRunsArgs(argv);
  // A refused command line still answers in the form it asked for.
  if (!parsed.ok) emit(parsed, argv.includes("--json"));
  const { command, slug, active, json } = parsed.data;

  if (command === "show") {
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
    const removed = removeRunState(slug as string);
    emit(
      removed
        ? { ok: true, data: { removed: slug }, error: null }
        : { ok: false, data: null, error: `No forge run named "${slug}".` },
      json,
      `Removed run "${slug}".`,
    );
  }

  const all = listRuns();
  const runs = active ? activeRuns(all) : all;
  const heading =
    runs.length === 0
      ? "No forge runs. Start one with /forgemaster <feature>."
      : `${runs.length} forge run${runs.length === 1 ? "" : "s"}:\n\n${runs.map(runLine).join("\n\n")}`;
  emit({ ok: true, data: runs, error: null }, json, heading);
}
