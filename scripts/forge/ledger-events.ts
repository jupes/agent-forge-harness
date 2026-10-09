/**
 * The ledger events a Forge run emits: a phase entered, a phase completed, a
 * verdict file bound to the run, a review round recorded.
 *
 * Imported only by the Bun CLIs (`phase-gate.ts`, `auto-loop-cli.ts`), and
 * only when they run as commands: the ledger loads `bun:sqlite`, which the
 * modules the dashboard bundles for the browser (`runs.ts`, `phases.ts`,
 * `review-rules.ts`) must never reach.
 */

import type {
  Executor,
  LedgerEventInput,
  LedgerPayloads,
  VerdictArtifact,
} from "../../types/hearth";
import {
  EVAL_VERDICT_SCHEMA_VERSION,
  type EvalVerdictParsed,
  observedExecutor,
} from "../eval-verdict";
import { type AppendResult, appendEvent } from "../ledger/append";
import { type Attach, resolveAttach } from "../ledger/identity";
import { lastEvent } from "../ledger/query";
import type {
  ForgePhase,
  ForgeState,
  ReviewAction,
  ReviewRound,
} from "./phases";

type Env = Readonly<Record<string, string | undefined>>;

type RunEventKind =
  | "run.phase.entered"
  | "run.phase.completed"
  | "review.recorded"
  | "verdict.bound";

/** A run event before it is tied to a workspace, a session and an executor. */
export type RunEvent = {
  [K in RunEventKind]: { kind: K; payload: LedgerPayloads[K] };
}[RunEventKind];

export function phaseEntered(phase: ForgePhase): RunEvent {
  return { kind: "run.phase.entered", payload: { phase } };
}

export function phaseCompleted(phase: ForgePhase, artifact?: string): RunEvent {
  return {
    kind: "run.phase.completed",
    payload: { phase, ...(artifact ? { artifact } : {}) },
  };
}

/** The round as metadata: the counts and the decision, never the summary text. */
export function reviewRecorded(
  round: ReviewRound,
  action: ReviewAction,
): RunEvent {
  return {
    kind: "review.recorded",
    payload: {
      phase: round.phase,
      round: round.round,
      verdict: round.verdict,
      findings: {
        blocker: round.findings.blocker,
        high: round.findings.high,
        medium: round.findings.medium,
        low: round.findings.low,
      },
      action,
    },
  };
}

/**
 * A verdict file as the ledger binds it: the outcome, who built the work
 * under review when the run recorded that, who judged it, and the file's own
 * summary (an opt-in body the ledger redacts and caps).
 *
 * A schema 2 verdict gives the typed evaluator as declared, and an evaluator
 * executor only from what it says was observed to run. A legacy (schema 1)
 * verdict names no evaluator, so neither is recorded. `null` is a file that
 * could not be read or parsed, or is not this run's. `artifact` is the file
 * as the emitter read it, when it hashed the bytes it parsed.
 */
export function verdictBound(input: {
  verdict: EvalVerdictParsed | null;
  builder?: Executor;
  artifact?: VerdictArtifact;
}): RunEvent & { kind: "verdict.bound" } {
  const { verdict, builder, artifact } = input;
  const identity =
    verdict?.schemaVersion === EVAL_VERDICT_SCHEMA_VERSION
      ? verdict.evaluator
      : undefined;
  const evaluator = identity ? observedExecutor(identity) : undefined;
  return {
    kind: "verdict.bound",
    payload: {
      verdict:
        verdict === null
          ? "unreadable"
          : verdict.verdict === "PASS"
            ? "pass"
            : "fail",
      ...(builder ? { builder } : {}),
      ...(evaluator ? { evaluator } : {}),
      ...(identity ? { evaluatorIdentity: identity } : {}),
      ...(verdict !== null && artifact ? { verdictArtifact: artifact } : {}),
      ...(verdict?.summary ? { summary: verdict.summary } : {}),
    },
  };
}

export interface RunAttachInput {
  /** The `--slug`: always the event's run, whatever the environment says. */
  slug: string;
  /** The run's state, for the bead and executor nothing closer supplies. */
  state: ForgeState | null;
  /** From `--bead` and `--provider/--model`. */
  explicit?: { beadId?: string; executor?: Executor };
  cwd?: string;
  env?: Env;
  /** The ledger file the session's cached model is read from. */
  path?: string;
}

/** Who and what a run's event belongs to: flags, then environment, then run state. */
export function attachRun(input: RunAttachInput): Attach {
  const fallbackBead = input.state?.beadId ?? input.state?.epic;
  return resolveAttach({
    cwd: input.cwd ?? process.cwd(),
    env: input.env ?? process.env,
    explicit: { runId: input.slug, ...input.explicit },
    fallback: {
      ...(fallbackBead ? { beadId: fallbackBead } : {}),
      ...(input.state?.executor ? { executor: input.state.executor } : {}),
    },
    ...(input.path !== undefined ? { path: input.path } : {}),
  });
}

/**
 * The executor a phase-gate write stores on the run: the one named by flags,
 * else the live session's (when its model is known), else whatever the run
 * already had.
 */
export function executorToPersist(
  attach: Attach,
  explicit: Executor | undefined,
  stored: Executor | undefined,
): Executor | undefined {
  if (explicit) {
    return attach.sessionId !== undefined && explicit.sessionId === undefined
      ? { ...explicit, sessionId: attach.sessionId }
      : explicit;
  }
  const live = attach.executor;
  if (live?.sessionId !== undefined && live.sessionId === attach.sessionId) {
    return live;
  }
  return stored;
}

/** The run's stored executor, pointed at the session now working the run. */
export function withLiveSession(
  stored: Executor | undefined,
  attach: Attach,
): Executor | undefined {
  if (!stored || attach.sessionId === undefined) return stored;
  return { ...stored, sessionId: attach.sessionId };
}

/** Append one run event. Never throws: a run must not fail on its audit trail. */
export function emitRunEvent(
  attach: Attach,
  event: RunEvent,
  opts: { path?: string } = {},
): AppendResult {
  try {
    const input: LedgerEventInput = {
      ...event,
      workspace: attach.workspace,
      ...(attach.beadId !== undefined ? { beadId: attach.beadId } : {}),
      ...(attach.runId !== undefined ? { runId: attach.runId } : {}),
      ...(attach.sessionId !== undefined
        ? { sessionId: attach.sessionId }
        : {}),
      ...(attach.executor ? { executor: attach.executor } : {}),
    };
    return appendEvent(input, opts);
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Append `run.phase.entered`, unless the run's most recent phase event is
 * already that: re-running the entry check must not fill the ledger.
 * Returns null when nothing was appended.
 */
export function emitPhaseEntered(
  attach: Attach,
  phase: ForgePhase,
  opts: { path?: string } = {},
): AppendResult | null {
  if (attach.runId !== undefined) {
    const last = lastEvent(
      {
        runId: attach.runId,
        kinds: ["run.phase.entered", "run.phase.completed"],
      },
      opts,
    );
    if (last?.kind === "run.phase.entered" && last.payload.phase === phase) {
      return null;
    }
  }
  return emitRunEvent(attach, phaseEntered(phase), opts);
}
