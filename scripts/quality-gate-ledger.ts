/**
 * The ledger events a quality-gate run emits: `gate.ran` for the run itself
 * and, when the strict evaluator-verdict check read a verdict, `verdict.bound`.
 *
 * Builders only — `.claude/hooks/quality-gate.ts` appends what they return.
 * This module reaches the ledger (and so Bun's SQLite); only that hook and
 * tests load it.
 */

import type { Executor, LedgerEventInput } from "../types/hearth";
import type { EvalVerdictParsed } from "./eval-verdict";
import { verdictBound } from "./forge/ledger-events";
import type { ForgeState } from "./forge/phases";
import { type Attach, resolveAttach } from "./ledger/identity";
import type { RunCorrelation } from "./run-correlation";

type Env = Readonly<Record<string, string | undefined>>;

/** The name every `gate.ran` from this gate carries. */
export const QUALITY_GATE_NAME = "quality-gate";

/** The gate blocks completion with exit code 2 and passes with 0. */
const EXIT_PASSED = 0;
const EXIT_BLOCKED = 2;

/**
 * Who a gate run belongs to.
 *
 * The bead and the run are the correlation's, or absent: a gate that was not
 * correlated claims neither, whatever the environment or a run's state could
 * suggest. The session comes from the worktree's mirror and the executor from
 * that session's cached model, else from the correlated run's stored executor.
 */
export function gateAttach(input: {
  cwd: string;
  env: Env;
  /** The validated correlation the gate was pointed at, or null. */
  correlation: RunCorrelation | null;
  /** The state of the correlated run, when it has one on disk. */
  state: ForgeState | null;
  /** The ledger file the session's cached model is read from. */
  path?: string;
}): Attach {
  const { correlation, state } = input;
  const {
    beadId: _bead,
    runId: _run,
    ...who
  } = resolveAttach({
    cwd: input.cwd,
    env: input.env,
    fallback: state?.executor ? { executor: state.executor } : {},
    ...(input.path !== undefined ? { path: input.path } : {}),
  });
  return correlation === null
    ? who
    : {
        ...who,
        beadId: correlation.beadsIssueId,
        runId: correlation.executionRunId,
      };
}

/** The correlation fields of `attach`, with only the known ones present. */
function correlation(
  attach: Attach,
): Pick<
  LedgerEventInput,
  "workspace" | "beadId" | "runId" | "sessionId" | "executor"
> {
  return {
    workspace: attach.workspace,
    ...(attach.beadId !== undefined ? { beadId: attach.beadId } : {}),
    ...(attach.runId !== undefined ? { runId: attach.runId } : {}),
    ...(attach.sessionId !== undefined ? { sessionId: attach.sessionId } : {}),
    ...(attach.executor ? { executor: attach.executor } : {}),
  };
}

/** One gate run as a `gate.ran` event. `trigger` is the hook event that ran it, when known. */
export function gateRanEvent(input: {
  result: { passed: boolean };
  durationMs: number;
  trigger?: string;
  attach: Attach;
}): LedgerEventInput & { kind: "gate.ran" } {
  const { result } = input;
  return {
    kind: "gate.ran",
    ...correlation(input.attach),
    payload: {
      gate: QUALITY_GATE_NAME,
      passed: result.passed,
      durationMs: Math.max(0, Math.round(input.durationMs)),
      exitCode: result.passed ? EXIT_PASSED : EXIT_BLOCKED,
      ...(input.trigger ? { trigger: input.trigger } : {}),
    },
  };
}

/**
 * The verdict the strict check read. The strict check only binds a verdict
 * whose `taskId` is the correlated bead, so the bead here is that one.
 * `builder` is the run's stored executor, when there is one. The verdict file
 * names no evaluator, so the event has none.
 */
export function strictVerdictEvent(input: {
  verdict: EvalVerdictParsed;
  builder?: Executor;
  attach: Attach;
}): LedgerEventInput & { kind: "verdict.bound" } {
  const { payload } = verdictBound({
    verdict: input.verdict,
    ...(input.builder ? { builder: input.builder } : {}),
  });
  return {
    kind: "verdict.bound",
    ...correlation(input.attach),
    beadId: input.verdict.taskId,
    payload,
  };
}
