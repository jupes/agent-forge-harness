#!/usr/bin/env bun
/**
 * auto-loop-cli.ts — record a subagent review round and get the next move.
 *
 * `/forgemaster-auto` runs unattended, so "did that review pass, and what now?"
 * has to be a command with an exit code rather than a judgement call the agent
 * makes about its own work. This reads the evaluator's verdict file (a schema
 * 2 verdict must name the run and the bead of the run's correlation; a run
 * with no correlation can only be graded from a legacy schema 1 verdict), appends
 * the round to the run's ledger together with the decision it reached, and
 * prints that decision. The stored decision is what the phase gate and the
 * runs table read afterwards, so a halt here is a halt everywhere; the round
 * is also appended to the event ledger as `verdict.bound` (the verdict file
 * as read) and `review.recorded` (the decision).
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
  type EvalVerdictParsed,
  parseEvalVerdictJson,
  verdictForRun,
} from "../eval-verdict";
import { readVerdictFileAt } from "../eval-verdict-store";
import { strictEvaluatorProblem } from "../evaluator-policy";
import { resolveCheckout } from "../ledger/workspace";
import { type RunCorrelation, runCorrelationPath } from "../run-correlation";
import {
  type AutoDecision,
  decideNext,
  haltHandoff,
  recordRound,
  reviewComment,
  roundFromVerdict,
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

function getFlag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
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
 * verdict naming that bead and run. A run with no correlation has nothing a
 * schema 2 verdict could be checked against, and takes only a legacy one.
 */
export function verdictOfRun(
  parsed: EvalVerdictParsed,
  slug: string,
  correlation:
    | { kind: "found"; value: RunCorrelation }
    | { kind: "none" }
    | { kind: "refused"; error: string },
): { ok: true; value: EvalVerdictParsed } | { ok: false; error: string } {
  if (correlation.kind === "refused") {
    return {
      ok: false,
      error: `run "${slug}" has a run correlation that cannot be used (${correlation.error}), so no verdict can be checked against it`,
    };
  }
  if (correlation.kind === "found") {
    const mine = verdictForRun(parsed, correlation.value);
    return mine.ok
      ? mine
      : parsed.schemaVersion === EVAL_VERDICT_SCHEMA_VERSION
        ? mine
        : {
            ok: false,
            error: `run "${slug}" is correlated to ${correlation.value.beadsIssueId}, so its verdict must be schema 2; ${mine.error}`,
          };
  }
  if (parsed.schemaVersion === EVAL_VERDICT_SCHEMA_VERSION) {
    return {
      ok: false,
      error: `run "${slug}" has no run correlation, so a schema 2 verdict cannot be checked against it (bun run forge:correlate --bead <id> --run ${slug})`,
    };
  }
  return { ok: true, value: parsed };
}

if (import.meta.main) {
  const argv = process.argv.slice(2);

  const slug = getFlag(argv, "slug");
  if (!slug || !isValidSlug(slug)) {
    fail("Missing or unusable --slug <slug>.");
  }
  const state = readRunState(slug);
  if (state === null) {
    fail(
      `No forge run named "${slug}". A run records state once its first phase completes.`,
    );
  }

  if (argv.includes("--ledger")) {
    emit({ ok: true, data: state.reviews ?? [], error: null }, 0);
  }

  const phaseArg = getFlag(argv, "phase");
  if (!phaseArg || !isForgePhase(phaseArg)) {
    fail("Missing or unknown --phase <research|plan|implement|ship>.");
  }
  const phase = phaseArg;
  const history = state.reviews ?? [];

  const budgetArg = getFlag(argv, "max-revisions");
  if (budgetArg !== undefined && !/^\d+$/.test(budgetArg)) {
    fail(`--max-revisions must be a non-negative integer, not "${budgetArg}".`);
  }
  const budget =
    budgetArg === undefined ? {} : { maxRevisions: Number(budgetArg) };

  if (argv.includes("--decision-only")) {
    const decision = decideNext({ phase, history, ...budget });
    emit(
      { ok: true, data: { decision, rounds: history.length }, error: null },
      exitCodeFor(decision.action),
    );
  }

  const verdictPath = getFlag(argv, "verdict");
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
      : ({ kind: "none" } as const);

  // An unreadable or invalid verdict is recorded, not swallowed: decideNext
  // halts on it, which is the point — an auto run must not grade itself blind.
  // A verdict that is not this run's is as unusable as one that cannot be read.
  // The file is read once: the bytes that are parsed are the bytes whose
  // digest goes into the ledger.
  let verdict: EvalVerdictParsed | null = null;
  let verdictError: string | null = null;
  const read = readVerdictFileAt(verdictPath);
  if (!read.ok) {
    verdictError = read.error;
  } else {
    const parsed = parseEvalVerdictJson(read.buffer.toString("utf8"));
    if (!parsed.ok) {
      verdictError = parsed.error;
    } else {
      const mine = verdictOfRun(parsed.value, slug, correlation);
      if (mine.ok) verdict = mine.value;
      else verdictError = mine.error;
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
  const bound =
    verdict?.schemaVersion === EVAL_VERDICT_SCHEMA_VERSION ? verdict : null;

  // Whether the evaluator would satisfy strict completion. Reported, not
  // enforced: the review loop's own rule is the verdict's findings.
  let evaluatorProblem: string | null = null;
  if (bound?.evaluator.kind === "model") {
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
    evaluatorProblem = strictEvaluatorProblem(bound.evaluator, {
      smiths,
      ...(state.executor ? { builder: state.executor } : {}),
    });
  }

  const graded = roundFromVerdict({
    phase,
    history,
    verdict,
    at: new Date().toISOString(),
    ...(getFlag(argv, "tier") ? { tier: getFlag(argv, "tier") as string } : {}),
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
  // Both rows of a round graded from a schema 2 verdict are filed under the
  // bead and run the verdict names, which are the correlation's.
  const roundAttach = bound
    ? { ...attach, beadId: bound.beadsIssueId, runId: bound.executionRunId }
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
        comment: reviewComment(round, {
          legacy: verdict !== null && bound === null,
        }),
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
