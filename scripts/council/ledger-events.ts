/**
 * The ledger events a council run emits: one when it starts, one when it ends.
 *
 * Builders only, with type-only imports. `workflow.ts` and `service.ts` load
 * this file, and neither they nor it import the ledger: the function that
 * appends is handed in by a Bun entry point (see `ledger-wiring.ts`), so a
 * host that hands in nothing loads no SQLite driver and records nothing.
 */

import type {
  Executor,
  LedgerEventInput,
  LedgerPayloads,
} from "../../types/hearth";
import type { AggregatedFinding, CouncilRun, FindingSeverity } from "./types";

/** Who a council run's events belong to, resolved by the caller. Plain data. */
export type CouncilAttach = {
  workspace: string;
  beadId?: string;
  /** The Forge run the review was asked for from, when there is one. */
  runId?: string;
  sessionId?: string;
  executor?: Executor;
};

/** Appends one event. Its result is ignored: a review never depends on it. */
export type CouncilAppend = (event: LedgerEventInput) => unknown;

/** Resolves who a council run started from `cwd` belongs to. */
export type CouncilAttachResolver = (hints: {
  cwd: string;
  beadId?: string;
}) => CouncilAttach;

type CouncilEventKind = "council.run.started" | "council.run.finished";

/** A council event before it is tied to a workspace, a bead and an executor. */
export type CouncilLedgerEvent = {
  [K in CouncilEventKind]: { kind: K; payload: LedgerPayloads[K] };
}[CouncilEventKind];

type Outcome = LedgerPayloads["council.run.finished"]["outcome"];

/**
 * A finished run as one outcome. A cancelled run is `cancelled`; a failed run
 * reached no verdict, so it is `unreadable`. A completed run follows its
 * chair: `pass`, `needs_changes` as `fail`, `insufficient_evidence` as
 * `unreadable`. With no chair, a blocker or high finding makes it `fail`.
 */
export function councilOutcome(
  run: Pick<CouncilRun, "status" | "chair" | "aggregatedFindings">,
): Outcome {
  if (run.status === "cancelled") return "cancelled";
  if (run.status === "failed") return "unreadable";
  if (run.chair) {
    switch (run.chair.verdict) {
      case "pass":
        return "pass";
      case "needs_changes":
        return "fail";
      case "insufficient_evidence":
        return "unreadable";
    }
  }
  return run.aggregatedFindings.some(
    (finding) => finding.severity === "blocker" || finding.severity === "high",
  )
    ? "fail"
    : "pass";
}

/**
 * A run's findings counted by severity, every one of them whatever its
 * resolution, as the run's report lists them. `FindingSeverity` is the four
 * severities `review.recorded` counts under the same names, so no severity is
 * mapped; the `Record` makes a severity added later a compile error here until
 * it is. Numbers only: no finding text is read.
 */
export function countFindingsBySeverity(
  findings: ReadonlyArray<Pick<AggregatedFinding, "severity">>,
): Record<FindingSeverity, number> {
  const counts: Record<FindingSeverity, number> = {
    blocker: 0,
    high: 0,
    medium: 0,
    low: 0,
  };
  for (const finding of findings) counts[finding.severity]++;
  return counts;
}

export function councilStarted(
  councilRunId: string,
  profileId: string,
  budgetUsd?: number,
): CouncilLedgerEvent {
  return {
    kind: "council.run.started",
    payload: {
      councilRunId,
      profile: profileId,
      ...(budgetUsd !== undefined && Number.isFinite(budgetUsd)
        ? { budgetUsd }
        : {}),
    },
  };
}

/**
 * The end of a run. `run` is null when execution threw before producing one:
 * there is no verdict to read, so the outcome is `unreadable`. The chair's
 * summary is the one body stored; seat outputs and finding text never are.
 * A completed run also records its findings counted by severity (zeros when
 * it found nothing); a failed or cancelled run reached no verdict, so it
 * records none, which the scoreboard reads as "not recorded" and not as zero.
 */
export function councilFinished(
  councilRunId: string,
  run: Pick<
    CouncilRun,
    "status" | "chair" | "aggregatedFindings" | "accountedCostUsd"
  > | null,
): CouncilLedgerEvent {
  if (run === null) {
    return {
      kind: "council.run.finished",
      payload: { councilRunId, outcome: "unreadable" },
    };
  }
  return {
    kind: "council.run.finished",
    payload: {
      councilRunId,
      outcome: councilOutcome(run),
      ...(Number.isFinite(run.accountedCostUsd)
        ? { costUsd: run.accountedCostUsd }
        : {}),
      ...(run.chair?.summary ? { summary: run.chair.summary } : {}),
      ...(run.status === "completed"
        ? { findings: countFindingsBySeverity(run.aggregatedFindings) }
        : {}),
    },
  };
}

/** A council event tied to who it belongs to, ready to append. */
export function councilLedgerEvent(
  attach: CouncilAttach,
  event: CouncilLedgerEvent,
): LedgerEventInput {
  return {
    ...event,
    workspace: attach.workspace,
    ...(attach.beadId !== undefined ? { beadId: attach.beadId } : {}),
    ...(attach.runId !== undefined ? { runId: attach.runId } : {}),
    ...(attach.sessionId !== undefined ? { sessionId: attach.sessionId } : {}),
    ...(attach.executor ? { executor: attach.executor } : {}),
  };
}
