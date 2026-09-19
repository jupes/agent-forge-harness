#!/usr/bin/env bun
/**
 * auto-loop-cli.ts — record a subagent review round and get the next move.
 *
 * `/forgemaster-auto` runs unattended, so "did that review pass, and what now?"
 * has to be a command with an exit code rather than a judgement call the agent
 * makes about its own work. This reads the evaluator's verdict file, appends
 * the round to the run's ledger, and prints the decision.
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

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";

import { parseEvalVerdictJson } from "../eval-verdict";
import {
  type AutoDecision,
  decideNext,
  haltHandoff,
  recordRound,
  reviewComment,
  roundFromVerdict,
} from "./auto-loop";
import { isForgePhase } from "./phases";
import { isValidSlug, readRunState, writeRunState } from "./runs";

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

  // An unreadable or invalid verdict is recorded, not swallowed: decideNext
  // halts on it, which is the point — an auto run must not grade itself blind.
  let verdict = null;
  let verdictError: string | null = null;
  try {
    const parsed = parseEvalVerdictJson(readFileSync(verdictPath, "utf8"));
    if (parsed.ok) verdict = parsed.value;
    else verdictError = parsed.error;
  } catch {
    verdictError = `could not read ${verdictPath}`;
  }

  const round = roundFromVerdict({
    phase,
    history,
    verdict,
    at: new Date().toISOString(),
    ...(getFlag(argv, "tier") ? { tier: getFlag(argv, "tier") as string } : {}),
  });
  const next = recordRound(state, round);
  writeRunState(next);

  const decision = decideNext({
    phase,
    history: next.reviews ?? [],
    ...budget,
  });

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
        ...(verdictError ? { verdictError } : {}),
        ...(handoff ? { handoff } : {}),
      },
      error: null,
    },
    exitCodeFor(decision.action),
  );
}
