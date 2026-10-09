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

type Env = Readonly<Record<string, string | undefined>>;

/** The name every `gate.ran` from this gate carries. */
export const QUALITY_GATE_NAME = "quality-gate";

/** The gate blocks completion with exit code 2 and passes with 0. */
const EXIT_PASSED = 0;
const EXIT_BLOCKED = 2;

/**
 * Who a gate run belongs to. The session comes from the worktree's mirror, the
 * executor from that session's cached model or else the run's stored executor,
 * the bead from the environment or else the run. `forgeSlug` is the run the
 * gate already established for its log entry, so it is not re-derived here.
 */
export function gateAttach(input: {
  cwd: string;
  env: Env;
  forgeSlug: string | null;
  /** The state of the run named by `forgeSlug`, when it has one on disk. */
  state: ForgeState | null;
  /** The ledger file the session's cached model is read from. */
  path?: string;
}): Attach {
  const { state } = input;
  const fallbackBead = state?.beadId ?? state?.epic;
  return resolveAttach({
    cwd: input.cwd,
    env: input.env,
    explicit: input.forgeSlug !== null ? { runId: input.forgeSlug } : {},
    fallback: {
      ...(fallbackBead ? { beadId: fallbackBead } : {}),
      ...(state?.executor ? { executor: state.executor } : {}),
    },
    ...(input.path !== undefined ? { path: input.path } : {}),
  });
}

/** The correlation fields of `attach`, with only the known ones present. */
function correlation(
  attach: Attach,
  forgeSlug: string | null,
): Pick<
  LedgerEventInput,
  "workspace" | "beadId" | "runId" | "sessionId" | "executor"
> {
  const runId = forgeSlug ?? attach.runId;
  return {
    workspace: attach.workspace,
    ...(attach.beadId !== undefined ? { beadId: attach.beadId } : {}),
    ...(runId !== undefined ? { runId } : {}),
    ...(attach.sessionId !== undefined ? { sessionId: attach.sessionId } : {}),
    ...(attach.executor ? { executor: attach.executor } : {}),
  };
}

/** One gate run as a `gate.ran` event. `trigger` is the hook event that ran it, when known. */
export function gateRanEvent(input: {
  result: { passed: boolean; forgeSlug: string | null };
  durationMs: number;
  trigger?: string;
  attach: Attach;
}): LedgerEventInput & { kind: "gate.ran" } {
  const { result } = input;
  return {
    kind: "gate.ran",
    ...correlation(input.attach, result.forgeSlug),
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
 * The verdict the strict check read, bound to the bead the verdict itself
 * names (its `taskId` is a Beads id by the evaluation-verdict protocol).
 * `builder` is the run's stored executor, when there is one. The verdict file
 * names no evaluator, so the event has none.
 */
export function strictVerdictEvent(input: {
  verdict: EvalVerdictParsed;
  forgeSlug: string | null;
  builder?: Executor;
  attach: Attach;
}): LedgerEventInput & { kind: "verdict.bound" } {
  const { payload } = verdictBound({
    verdict: input.verdict,
    ...(input.builder ? { builder: input.builder } : {}),
  });
  return {
    kind: "verdict.bound",
    ...correlation(input.attach, input.forgeSlug),
    beadId: input.verdict.taskId,
    payload,
  };
}
