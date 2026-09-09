import { randomUUID } from "crypto";
import {
  aggregateFindings,
  isIndependentSuccess,
  preparePeerCandidates,
} from "./deliberation";
import { callSeat, reportedCost, reserveRequestCost } from "./model-call";
import {
  parseChairOutput,
  parseIndependentOutput,
  parsePeerOutput,
} from "./output-validation";
import {
  chairPrompt,
  chairSystem,
  independentPrompt,
  independentSystem,
  peerPrompt,
  peerSystem,
} from "./prompts";
import { finalRun, reviewLimitations } from "./run-result";
import {
  type AggregatedFinding,
  COUNCIL_SCHEMA_VERSION,
  type ContextPack,
  type CouncilDiscussionRound,
  type CouncilEvent,
  type CouncilExecutionResult,
  type CouncilProfile,
  type CouncilSeat,
  estimateCouncilCost,
  type ModelRequest,
  type ModelTransport,
  type SeatRecord,
} from "./types";

// Preserve the original public entry points while implementations stay focused.
export {
  FakeCouncilTransport,
  type FakeTransportOptions,
} from "./fake-transport";
export { reserveRequestCost, runIndependentReview } from "./model-call";
export { parseIndependentOutput } from "./output-validation";
export { independentPrompt, independentSystem } from "./prompts";

export type CouncilEngineOptions = {
  profile: CouncilProfile;
  context: ContextPack;
  resolveTransport: (seat: CouncilSeat) => ModelTransport;
  signal?: AbortSignal;
  maxUsd?: number;
  runId?: string;
  now?: () => Date;
  onEvent?: (event: CouncilEvent) => void;
  onDiscussionRound?: (round: CouncilDiscussionRound) => void;
};

export async function runCouncil(
  options: CouncilEngineOptions,
): Promise<CouncilExecutionResult> {
  const now = options.now ?? (() => new Date());
  const runId =
    options.runId ??
    `council-${now().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
  const startedAt = now().toISOString();
  const events: CouncilEvent[] = [];
  const records: SeatRecord[] = [];
  const discussion: CouncilDiscussionRound[] = [];
  const publishRound = (round: CouncilDiscussionRound): void => {
    discussion.push(structuredClone(round));
    try {
      options.onDiscussionRound?.(structuredClone(round));
    } catch {
      // Observers cannot alter validated outputs or interrupt deliberation.
    }
  };
  let sequence = 0;
  const emit = (
    type: string,
    payload: Record<string, unknown>,
  ): CouncilEvent => {
    const event: CouncilEvent = {
      schemaVersion: COUNCIL_SCHEMA_VERSION,
      runId,
      seq: sequence,
      at: now().toISOString(),
      type,
      payload,
    };
    sequence += 1;
    events.push(event);
    try {
      options.onEvent?.(event);
    } catch {
      // An observer must never be able to break a council run.
    }
    return event;
  };

  const estimate = estimateCouncilCost(options.profile);
  emit("run.started", {
    profileId: options.profile.id,
    sourceKind: options.context.source.kind,
    estimatedCostUsd: estimate,
  });

  const finishFailure = (
    status: "failed" | "cancelled",
    error: string,
    aggregatedFindings: AggregatedFinding[] = [],
  ): CouncilExecutionResult => {
    emit(status === "cancelled" ? "run.cancelled" : "run.failed", { error });
    const run = finalRun(
      status,
      startedAt,
      options.profile,
      options.context,
      runId,
      estimate,
      records,
      aggregatedFindings,
      events,
      now,
      undefined,
      error,
    );
    run.discussion = discussion;
    return { ok: false, run, error };
  };

  const budget = options.maxUsd ?? options.profile.maxEstimatedUsd;
  if (!Number.isFinite(budget) || budget < 0) {
    return finishFailure("failed", "budget must be a non-negative number");
  }
  if (estimate > budget) {
    return finishFailure(
      "failed",
      `estimated cost $${estimate.toFixed(4)} exceeds budget $${budget.toFixed(4)}`,
    );
  }
  if (options.signal?.aborted) {
    return finishFailure("cancelled", "council run cancelled");
  }

  emit("stage.started", {
    stage: "independent",
    seatCount: options.profile.seats.length,
  });
  const independentRequests: ModelRequest[] = options.profile.seats.map(
    (seat) => ({
      runId,
      stage: "independent",
      seat,
      system: independentSystem(seat),
      prompt: independentPrompt(options.context),
      context: options.context,
    }),
  );
  if (
    independentRequests.reduce(
      (sum, request) => sum + reserveRequestCost(request),
      0,
    ) > budget
  )
    return finishFailure(
      "failed",
      "estimated token cost cannot reserve independent round within budget",
    );
  const independentRecords = await Promise.all(
    independentRequests.map((request) =>
      callSeat(
        request,
        options.resolveTransport,
        (value) =>
          parseIndependentOutput(
            value,
            new Set(options.context.evidence.map((item) => item.id)),
          ),
        options.signal,
        emit,
      ),
    ),
  );
  records.push(...independentRecords);
  publishRound({
    stage: "independent",
    completedAt: now().toISOString(),
    records: independentRecords,
    findings: aggregateFindings(
      independentRecords.filter(isIndependentSuccess),
      [],
      options.profile,
    ),
    candidateTitles: {},
  });
  emit("stage.completed", {
    stage: "independent",
    completed: independentRecords.filter(
      (record) => record.status === "completed",
    ).length,
    failed: independentRecords.filter((record) => record.status !== "completed")
      .length,
  });

  if (options.signal?.aborted) {
    return finishFailure("cancelled", "council run cancelled");
  }
  if (reportedCost(records) > budget) {
    return finishFailure(
      "failed",
      `reported cost $${reportedCost(records).toFixed(4)} exceeds budget $${budget.toFixed(4)}`,
    );
  }
  const independentSuccesses = independentRecords.filter(isIndependentSuccess);
  if (independentSuccesses.length < options.profile.minQuorum) {
    return finishFailure(
      "failed",
      `independent quorum not met: ${independentSuccesses.length}/${options.profile.minQuorum}`,
    );
  }

  const peerRecords: SeatRecord[] = [];
  const discussionRounds =
    options.profile.depth === "quick"
      ? 0
      : options.profile.depth === "deep"
        ? 1 + (options.profile.maxDiscussionRounds ?? 1)
        : 1;
  for (let round = 0; round < discussionRounds; round += 1) {
    const stage = round === 0 ? "peer" : "revision";
    const priorFindings =
      round === 0
        ? undefined
        : aggregateFindings(independentSuccesses, peerRecords, options.profile);
    emit("stage.started", {
      stage,
      round,
      seatCount: independentSuccesses.length,
    });
    const requests: ModelRequest[] = independentSuccesses.map((record) => {
      const seat = options.profile.seats.find(
        (candidate) => candidate.id === record.seatId,
      )!;
      const prepared = preparePeerCandidates(
        independentSuccesses,
        seat,
        options.profile,
        runId,
        peerRecords,
      );
      return {
        runId,
        stage,
        round,
        seat,
        system: peerSystem(seat),
        prompt: peerPrompt(options.context, prepared.candidates, priorFindings),
        context: options.context,
        candidates: prepared.candidates,
      };
    });
    const reservedCost = requests.reduce(
      (total, request) => total + reserveRequestCost(request),
      0,
    );
    if (reportedCost(records) + reservedCost > budget)
      return finishFailure(
        "failed",
        `remaining budget cannot reserve ${stage} round`,
        aggregateFindings(independentSuccesses, peerRecords, options.profile),
      );
    const peerCalls = requests.map((request) =>
      callSeat(
        request,
        options.resolveTransport,
        (value) =>
          parsePeerOutput(
            value,
            new Set(options.context.evidence.map((item) => item.id)),
            new Set(
              (request.candidates ?? []).map(
                (candidate) => candidate.candidateId,
              ),
            ),
          ),
        options.signal,
        emit,
      ),
    );
    const roundRecords = await Promise.all(peerCalls);
    peerRecords.push(...roundRecords);
    records.push(...roundRecords);
    publishRound({
      stage,
      round,
      completedAt: now().toISOString(),
      records: roundRecords,
      findings: aggregateFindings(
        independentSuccesses,
        peerRecords,
        options.profile,
      ),
      candidateTitles: Object.fromEntries(
        requests.flatMap((request) =>
          (request.candidates ?? []).map((candidate) => [
            candidate.candidateId,
            candidate.finding.title,
          ]),
        ),
      ),
    });
    emit("stage.completed", {
      stage,
      round,
      completed: roundRecords.filter((record) => record.status === "completed")
        .length,
      failed: roundRecords.filter((record) => record.status !== "completed")
        .length,
    });
    if (options.signal?.aborted) {
      return finishFailure("cancelled", "council run cancelled");
    }
    if (reportedCost(records) > budget) {
      return finishFailure(
        "failed",
        `reported cost $${reportedCost(records).toFixed(4)} exceeds budget $${budget.toFixed(4)}`,
      );
    }
    const validPeerBallots = roundRecords.filter(
      (record) => record.status === "completed",
    ).length;
    if (validPeerBallots < options.profile.minPeerBallots) {
      return finishFailure(
        "failed",
        `peer ballot quorum not met: ${validPeerBallots}/${options.profile.minPeerBallots}`,
      );
    }
  }

  const aggregatedFindings = aggregateFindings(
    independentSuccesses,
    peerRecords,
    options.profile,
  );
  emit("findings.aggregated", {
    count: aggregatedFindings.length,
    contested: aggregatedFindings.filter((finding) => finding.contested).length,
  });

  const limitationState = reviewLimitations(
    options.context,
    options.profile,
    independentSuccesses,
    records,
    aggregatedFindings,
  );
  const limitations = limitationState.reported;

  emit("stage.started", { stage: "chair", seatCount: 1 });
  const chairRequest: ModelRequest = {
    runId,
    stage: "chair",
    seat: options.profile.chair,
    system: chairSystem(),
    prompt: chairPrompt(
      options.context,
      aggregatedFindings,
      records
        .filter((record) => record.status !== "completed")
        .map((record) => ({
          stage: record.stage,
          seatId: record.seatId,
          error: record.error ?? record.status,
        })),
      independentSuccesses,
      options.profile,
      limitations,
    ),
    context: options.context,
    aggregatedFindings,
  };
  if (reportedCost(records) + reserveRequestCost(chairRequest) > budget)
    return finishFailure(
      "failed",
      "remaining budget cannot reserve chair synthesis",
      aggregatedFindings,
    );
  const chairRecord = await callSeat(
    chairRequest,
    options.resolveTransport,
    (value) => parseChairOutput(value, aggregatedFindings),
    options.signal,
    emit,
  );
  records.push(chairRecord);
  emit("stage.completed", {
    stage: "chair",
    completed: chairRecord.status === "completed" ? 1 : 0,
    failed: chairRecord.status === "completed" ? 0 : 1,
  });
  if (options.signal?.aborted) {
    return finishFailure(
      "cancelled",
      "council run cancelled",
      aggregatedFindings,
    );
  }
  if (reportedCost(records) > budget) {
    return finishFailure(
      "failed",
      `reported cost $${reportedCost(records).toFixed(4)} exceeds budget $${budget.toFixed(4)}`,
      aggregatedFindings,
    );
  }
  if (
    chairRecord.status !== "completed" ||
    chairRecord.output === undefined ||
    !("summary" in chairRecord.output)
  ) {
    return finishFailure(
      "failed",
      `chair failed: ${chairRecord.error ?? chairRecord.status}`,
      aggregatedFindings,
    );
  }

  if (chairRecord.output.verdict === "pass") {
    const critical = aggregatedFindings.some(
      (finding) =>
        finding.consensusEligible &&
        (finding.severity === "blocker" || finding.severity === "high"),
    );
    const correctedVerdict = critical
      ? "needs_changes"
      : limitationState.blocking.length > 0
        ? "insufficient_evidence"
        : "pass";
    if (correctedVerdict !== "pass") {
      emit("verdict.corrected", {
        proposed: "pass",
        verdict: correctedVerdict,
        limitations,
      });
      chairRecord.output = {
        ...chairRecord.output,
        verdict: correctedVerdict,
        summary: `${critical ? "Critical findings require changes." : "The available review cannot establish a pass."} ${chairRecord.output.summary}`,
      };
    }
  }

  emit("run.completed", {
    verdict: chairRecord.output.verdict,
    findingCount: aggregatedFindings.length,
  });
  const run = finalRun(
    "completed",
    startedAt,
    options.profile,
    options.context,
    runId,
    estimate,
    records,
    aggregatedFindings,
    events,
    now,
    chairRecord.output,
    undefined,
    limitations,
  );
  run.discussion = discussion;
  return { ok: true, run };
}
