#!/usr/bin/env bun
/**
 * auto-loop-cli.ts — record a subagent review round and get the next move.
 *
 * `/forgemaster-auto` runs unattended, so "did that review pass, and what now?"
 * has to be a command with an exit code rather than a judgement call the agent
 * makes about its own work. This reads the evaluator's verdict file (a schema
 * 2 verdict naming the run and the bead of the run's correlation: a run with
 * no correlation, or a legacy schema 1 verdict, has its round recorded
 * `UNREADABLE`), appends the round to the run's ledger together with the
 * decision it reached, and
 * prints that decision. The stored decision is what the phase gate and the
 * runs table read afterwards, so a halt here is a halt everywhere; the round
 * is also appended to the event ledger as `verdict.bound` (the verdict file
 * as read) and `review.recorded` (the decision).
 *
 * A verdict whose model evaluator was observed to rank below the builder is
 * as unusable as one that is not the run's: its round is recorded
 * `UNREADABLE` (`observedBelowBuilder`). Anything else a strict gate would
 * object to in the evaluator is reported as `data.evaluatorProblem`, and the
 * round is graded on its findings.
 *
 * A round recorded `UNREADABLE` also stores why its verdict was unusable
 * (`verdictError`, cleaned by `storedVerdictError`), and the halt reason it
 * decides names it, so the run's state, `forge:runs`, the Stop reminder and
 * the halt handoff say what to fix: a file that could not be read or parsed, a
 * run with no correlation, a verdict that is not this run's, or an evaluator
 * that ranks below the builder (a re-review with a stronger one).
 *
 * Three things are refused before a round is recorded: a command line that
 * cannot be read whole (`parseReviewArgs`); a verdict file whose digest a
 * round of the run was already graded from, since a verdict grades one round;
 * and a verdict of the run that does not name the round this command would
 * record (`<phase>-<round>`, `roundLabelProblem`).
 *
 * CLI:
 *   bun run forge:review --slug <slug> --phase <phase> --verdict <path>
 *     [--tier <tier>] [--max-revisions <n>]
 *   bun run forge:review --slug <slug> --phase <phase> --decision-only
 *   bun run forge:review --slug <slug> --ledger
 *
 * Output is a single JSON object: { ok, data, error }.
 * Exit code 0 to advance, 3 to revise, 2 to halt (or on any error), so an
 * unattended caller can branch on the code alone.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "fs";
import { dirname, join, resolve } from "path";

import { loadConfig } from "../config/load";
import {
  EVAL_VERDICT_SCHEMA_VERSION,
  type EvalVerdict,
  type EvalVerdictParsed,
  parseEvalVerdictJson,
  verdictForRun,
} from "../eval-verdict";
import { readVerdictFileAt } from "../eval-verdict-store";
import { strictEvaluatorProblem } from "../evaluator-policy";
import { isMain } from "../is-main";
import { resolveCheckout } from "../ledger/workspace";
import { type RunCorrelation, runCorrelationPath } from "../run-correlation";
import {
  type AutoDecision,
  decideNext,
  haltHandoff,
  nextRoundOf,
  observedBelowBuilder,
  recordRound,
  reviewComment,
  roundFromVerdict,
  roundLabelProblem,
  roundRecordedFrom,
} from "./auto-loop";
import { type ForgeState, isForgePhase, type ReviewRound } from "./phases";
import { comparableCheckout, isValidSlug } from "./runs";
import { readRunState, writeRunState } from "./runs-store";

const HANDOFF_PATH = join(".tmp", "work", "session-handoff.md");

/** Exit code per action, so a shell caller can branch without parsing JSON. */
export function exitCodeFor(action: AutoDecision["action"]): number {
  switch (action) {
    case "advance":
      return 0;
    case "revise":
      return 3;
    case "halt":
      return 2;
  }
}

interface CliResult<T = unknown> {
  ok: boolean;
  data: T | null;
  error: string | null;
}

/** The flags that take a value. */
const VALUE_FLAGS = [
  "slug",
  "phase",
  "verdict",
  "tier",
  "max-revisions",
] as const;
/** The flags that take none. */
const SWITCHES = ["decision-only", "ledger"] as const;

type ReviewValueFlag = (typeof VALUE_FLAGS)[number];
type ReviewSwitch = (typeof SWITCHES)[number];

const isValueFlag = (name: string): name is ReviewValueFlag =>
  (VALUE_FLAGS as readonly string[]).includes(name);
const isSwitch = (name: string): name is ReviewSwitch =>
  (SWITCHES as readonly string[]).includes(name);

export interface ReviewArgs {
  values: Partial<Record<ReviewValueFlag, string>>;
  decisionOnly: boolean;
  ledger: boolean;
}

/**
 * The command line, read strictly: the value flags as `--flag value` or
 * `--flag=value`, and the two switches. A flag that is unknown, given twice or
 * left without its value is refused, and so is a word that is no flag's value:
 * a scripting slip must not become a recorded round. What the values mean
 * (a known phase, a usable slug) is the caller's to judge.
 */
export function parseReviewArgs(
  argv: readonly string[],
):
  | { ok: true; data: ReviewArgs; error: null }
  | { ok: false; data: null; error: string } {
  const refuse = (error: string) => ({ ok: false, data: null, error }) as const;
  const args: ReviewArgs = { values: {}, decisionOnly: false, ledger: false };
  const seen = new Set<string>();

  for (let at = 0; at < argv.length; at++) {
    const word = argv[at] as string;
    if (!word.startsWith("--")) {
      return refuse(`unexpected argument "${word}".`);
    }
    const equals = word.indexOf("=");
    const name = word.slice(2, equals < 0 ? undefined : equals);
    if (!isValueFlag(name) && !isSwitch(name)) {
      return refuse(
        `unknown flag --${name}. Known flags: ${[...VALUE_FLAGS, ...SWITCHES].map((flag) => `--${flag}`).join(", ")}.`,
      );
    }
    if (seen.has(name)) return refuse(`--${name} is given twice.`);
    seen.add(name);
    if (isSwitch(name)) {
      if (equals >= 0) return refuse(`--${name} takes no value.`);
      if (name === "ledger") args.ledger = true;
      else args.decisionOnly = true;
      continue;
    }
    // A value is the rest of the word after `=`, else the next word, which
    // must not be a flag itself.
    const value = equals >= 0 ? word.slice(equals + 1) : argv[++at];
    if (
      value === undefined ||
      value.trim().length === 0 ||
      (equals < 0 && value.startsWith("--"))
    ) {
      return refuse(`--${name} needs a value.`);
    }
    // A line copied from a document with its `<path>` still in it names nothing.
    if (/^<[^<>]*>$/.test(value.trim())) {
      return refuse(`--${name} ${value} is a placeholder, not a value.`);
    }
    args.values[name] = value;
  }
  return { ok: true, data: args, error: null };
}

function emit(result: CliResult, code: number): never {
  console.log(JSON.stringify(result, null, 2));
  process.exit(code);
}

function fail(error: string): never {
  emit({ ok: false, data: null, error }, 2);
}

/**
 * A verdict file's path as the ledger records it: relative to the checkout
 * when the file is inside it, else its real path in comparable form.
 */
function recordedPath(checkout: string, file: string): string {
  let real: string;
  try {
    real = comparableCheckout(realpathSync.native(file));
  } catch {
    real = comparableCheckout(resolve(file));
  }
  return real.startsWith(`${checkout}/`)
    ? real.slice(checkout.length + 1)
    : real;
}

/**
 * `parsed` as the verdict of run `slug`, or why it is not.
 *
 * The run's bead is its correlation's, not its state's: the two differ once a
 * run is rebound to a narrower issue. A correlated run takes only a schema 2
 * verdict naming that bead and run. A run with no correlation takes none: a
 * schema 2 verdict's ids have nothing to be checked against, and a legacy
 * schema 1 verdict names no run at all.
 */
export function verdictOfRun(
  parsed: EvalVerdictParsed,
  slug: string,
  correlation:
    | { kind: "found"; value: RunCorrelation }
    | {
        kind: "none";
        /** The checkout the run builds in, when the run's state names one. */
        checkout?: string;
      }
    | { kind: "refused"; error: string },
): { ok: true; value: EvalVerdict } | { ok: false; error: string } {
  if (correlation.kind === "refused") {
    return {
      ok: false,
      error: `run "${slug}" has a run correlation that cannot be used (${correlation.error}), so no verdict can be checked against it`,
    };
  }
  if (correlation.kind === "none") {
    return {
      ok: false,
      // The correlation has to be in the checkout the run builds in.
      error: `run "${slug}" has no run correlation, so no verdict can be checked against it (bun run forge:correlate --bead <id> --run ${slug}${correlation.checkout !== undefined ? ` --checkout "${correlation.checkout}"` : ""})`,
    };
  }
  const mine = verdictForRun(parsed, correlation.value);
  return mine.ok || parsed.schemaVersion === EVAL_VERDICT_SCHEMA_VERSION
    ? mine
    : {
        ok: false,
        error: `run "${slug}" is correlated to ${correlation.value.beadsIssueId}, so its verdict must be schema 2; ${mine.error}`,
      };
}

if (isMain(import.meta)) {
  const parsed = parseReviewArgs(process.argv.slice(2));
  if (!parsed.ok) fail(parsed.error);
  const args = parsed.data;

  const { slug } = args.values;
  if (!slug || !isValidSlug(slug)) {
    fail("Missing or unusable --slug <slug>.");
  }
  const state = readRunState(slug);
  if (state === null) {
    fail(
      `No forge run named "${slug}". A run records state once its first phase completes.`,
    );
  }

  if (args.ledger) {
    emit({ ok: true, data: state.reviews ?? [], error: null }, 0);
  }

  const phaseArg = args.values.phase;
  if (!phaseArg || !isForgePhase(phaseArg)) {
    fail("Missing or unknown --phase <research|plan|implement|ship>.");
  }
  const phase = phaseArg;
  const history = state.reviews ?? [];

  const budgetArg = args.values["max-revisions"];
  if (budgetArg !== undefined && !/^\d+$/.test(budgetArg)) {
    fail(`--max-revisions must be a non-negative integer, not "${budgetArg}".`);
  }
  const budget =
    budgetArg === undefined ? {} : { maxRevisions: Number(budgetArg) };

  if (args.decisionOnly) {
    const decision = decideNext({ phase, history, ...budget });
    emit(
      { ok: true, data: { decision, rounds: history.length }, error: null },
      exitCodeFor(decision.action),
    );
  }

  const verdictPath = args.values.verdict;
  if (!verdictPath) {
    fail("Missing required --verdict <path to the evaluator verdict JSON>.");
  }

  // The run's correlation lives at the top level of the checkout the run
  // builds in: the one place the loader looks, and the place "is there a file
  // at all" is asked of.
  const checkout = resolveCheckout(state.checkout ?? process.cwd()).worktree;
  const { loadRunCorrelation } = await import("../run-correlation-store");
  const pointer = runCorrelationPath(slug) ?? "";
  const loaded = loadRunCorrelation(pointer, checkout);
  const correlation = loaded.ok
    ? ({ kind: "found", value: loaded.value } as const)
    : existsSync(join(checkout, pointer))
      ? ({ kind: "refused", error: loaded.error } as const)
      : ({
          kind: "none",
          ...(state.checkout !== undefined ? { checkout: state.checkout } : {}),
        } as const);

  // The round this command would record, and how its verdict is filed: the
  // run's correlation is what `forge:verdict` needs, so a run with none is
  // correlated first.
  const roundNumber = nextRoundOf(phase, history);
  const label = `${phase}-${roundNumber}`;
  const onCheckout =
    state.checkout !== undefined ? ` --checkout "${state.checkout}"` : "";
  const fileRound =
    correlation.kind === "none"
      ? `correlate the run (bun run forge:correlate --bead <id> --run ${slug}${onCheckout}) and file this round's verdict with bun run forge:verdict --correlation <the pointer it prints> --review ${label}${onCheckout} ...`
      : `file this round's verdict with bun run forge:verdict --correlation ${pointer} --review ${label}${onCheckout} ...`;

  // An unreadable or invalid verdict is recorded, not swallowed: decideNext
  // halts on it, which is the point — an auto run must not grade itself blind.
  // A verdict that is not this run's is as unusable as one that cannot be read.
  // The file is read once: the bytes that are parsed are the bytes whose
  // digest goes into the ledger.
  let verdict: EvalVerdict | null = null;
  let verdictError: string | null = null;
  const read = readVerdictFileAt(verdictPath);
  // A verdict grades one round. The same bytes again, for a later round or
  // another phase, are that round's verdict replayed: refused, and nothing
  // is recorded, rather than graded a second time.
  const replayed = read.ok
    ? roundRecordedFrom(history, read.sha256)
    : undefined;
  if (read.ok && replayed !== undefined) {
    fail(
      `the verdict file ${verdictPath} (sha256 ${read.sha256.slice(0, 12)}) was already recorded for run "${slug}" as ${replayed.phase} round ${replayed.round}, and a verdict grades one round, so nothing was recorded. To record ${phase} round ${roundNumber}, ${fileRound}.`,
    );
  }
  if (!read.ok) {
    verdictError = read.error;
  } else {
    const parsed = parseEvalVerdictJson(read.buffer.toString("utf8"));
    if (!parsed.ok) {
      verdictError = parsed.error;
    } else {
      const mine = verdictOfRun(parsed.value, slug, correlation);
      if (mine.ok) {
        // A verdict of this run grades the round it names and no other: one
        // naming another round, another phase or none (the run's own verdict)
        // is refused, and nothing is recorded, as a replay is. Only a schema 2
        // verdict gets here: verdictOfRun takes no legacy one.
        const problem = roundLabelProblem(mine.value, label);
        if (problem !== null) {
          fail(
            `the verdict file ${verdictPath} ${problem}, but forge:review would record it as ${phase} round ${roundNumber} of run "${slug}" (${label}), and a verdict grades only the round it names, so nothing was recorded. To record that round, ${fileRound}.`,
          );
        }
        verdict = mine.value;
      } else verdictError = mine.error;
    }
  }

  // Whether the evaluator would satisfy strict completion. One objection is
  // enforced, because it rests on an observation: an evaluator observed to
  // rank below the builder grades nothing, and the round is recorded as one
  // with no usable verdict. Every other objection is reported, and the
  // round is graded on its findings.
  let evaluatorProblem: string | null = null;
  if (verdict?.evaluator.kind === "model") {
    let smiths: Parameters<typeof strictEvaluatorProblem>[1]["smiths"] = [];
    try {
      smiths = Object.values(
        loadConfig({ harnessRoot: checkout }).config.smiths,
      );
    } catch (error) {
      // Config that cannot be read ranks nobody: say that is why.
      console.error(
        `forge:review: smith config not readable, so no evaluator has a rank: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const ranks = {
      smiths,
      ...(state.executor ? { builder: state.executor } : {}),
    };
    evaluatorProblem = strictEvaluatorProblem(verdict.evaluator, ranks);
    const weaker = observedBelowBuilder(verdict.evaluator, ranks);
    if (weaker !== null) {
      verdict = null;
      verdictError = weaker;
    }
  }

  const artifact =
    verdict !== null && read.ok
      ? {
          path: recordedPath(checkout, verdictPath),
          sha256: read.sha256,
          bytes: read.bytes,
          schemaVersion: verdict.schemaVersion,
        }
      : null;

  const graded = roundFromVerdict({
    phase,
    history,
    verdict,
    ...(artifact ? { verdictSha256: artifact.sha256 } : {}),
    // Why there is no verdict, so the halt reason names it.
    ...(verdictError !== null ? { verdictError } : {}),
    at: new Date().toISOString(),
    ...(args.values.tier !== undefined ? { tier: args.values.tier } : {}),
  });
  // Decide first, from the history including this round, and store the
  // decision on the round: the revision budget is known only here, so anything
  // that re-derived it later could disagree with what this command printed.
  const decision = decideNext({
    phase,
    history: [...history, graded],
    ...budget,
  });
  const round: ReviewRound = {
    ...graded,
    action: decision.action,
    reason: decision.reason,
  };

  // Loaded here, not at the top: the ledger needs Bun's SQLite, and this
  // module's pure exports are imported without it.
  const ledger = await import("./ledger-events");
  const attach = ledger.attachRun({ slug, state });
  const executor = ledger.withLiveSession(state.executor, attach);
  const next: ForgeState = {
    ...recordRound(state, round),
    ...(executor ? { executor } : {}),
  };
  writeRunState(next);
  // The verdict file as it was read, then what the loop decided about it.
  // Both rows of a round graded from a verdict are filed under the bead and
  // run the verdict names, which are the correlation's.
  const roundAttach = verdict
    ? { ...attach, beadId: verdict.beadsIssueId, runId: verdict.executionRunId }
    : attach;
  ledger.emitRunEvent(
    roundAttach,
    ledger.verdictBound({
      verdict,
      ...(artifact ? { artifact } : {}),
      ...(state.executor ? { builder: state.executor } : {}),
    }),
  );
  ledger.emitRunEvent(
    roundAttach,
    ledger.reviewRecorded(round, decision.action),
  );

  let handoff: string | null = null;
  if (decision.action === "halt") {
    handoff = HANDOFF_PATH;
    try {
      mkdirSync(dirname(HANDOFF_PATH), { recursive: true });
      // Never clobber a handoff a human or another run is relying on.
      if (existsSync(HANDOFF_PATH)) {
        handoff = `${HANDOFF_PATH.replace(/\.md$/, "")}-${slug}.md`;
      }
      writeFileSync(
        handoff,
        haltHandoff({
          slug,
          phase,
          decision,
          history: next.reviews ?? [],
        }),
      );
    } catch {
      handoff = null;
    }
  }

  emit(
    {
      ok: true,
      data: {
        round,
        decision,
        comment: reviewComment(round),
        ...(verdict ? { verdictSchemaVersion: verdict.schemaVersion } : {}),
        ...(evaluatorProblem ? { evaluatorProblem } : {}),
        ...(verdictError ? { verdictError } : {}),
        ...(handoff ? { handoff } : {}),
      },
      error: null,
    },
    exitCodeFor(decision.action),
  );
}
