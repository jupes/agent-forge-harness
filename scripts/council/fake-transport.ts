import type {
  ChairOutput,
  CouncilStage,
  IndependentOutput,
  ModelRequest,
  ModelResult,
  ModelTransport,
  PeerOutput,
} from "./types";

export type FakeTransportOptions = {
  delayMs?: number | ((request: ModelRequest) => number);
  fail?: ReadonlyArray<{ stage: CouncilStage; seatId: string }>;
  output?: (request: ModelRequest) => unknown;
  costUsd?: number | ((request: ModelRequest) => number);
  onRequest?: (request: ModelRequest) => void;
};

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new Error("council run cancelled"));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new Error("council run cancelled"));
      },
      { once: true },
    );
  });
}

export class FakeCouncilTransport implements ModelTransport {
  readonly requests: ModelRequest[] = [];
  active = 0;
  maxActive = 0;

  constructor(private readonly options: FakeTransportOptions = {}) {}

  async generate(
    request: ModelRequest,
    signal: AbortSignal,
  ): Promise<ModelResult> {
    this.requests.push(request);
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    try {
      this.options.onRequest?.(request);
      const delay =
        typeof this.options.delayMs === "function"
          ? this.options.delayMs(request)
          : (this.options.delayMs ?? 5);
      await abortableDelay(delay, signal);
      if (
        this.options.fail?.some(
          (failure) =>
            failure.stage === request.stage &&
            failure.seatId === request.seat.id,
        )
      ) {
        throw new Error(
          `simulated ${request.stage} failure for ${request.seat.id}`,
        );
      }
      const costUsd =
        typeof this.options.costUsd === "function"
          ? this.options.costUsd(request)
          : (this.options.costUsd ?? 0);
      const custom = this.options.output?.(request);
      if (custom !== undefined) return { output: custom, costUsd };
      if (request.stage === "independent") {
        return {
          output: {
            verdict: "needs_changes",
            findings: [
              {
                localId: "F1",
                title: `Review concern from ${request.seat.role}`,
                severity: "medium",
                claim: "The artifact contains a claim that should be verified.",
                consequence: "An unverified claim can cause avoidable rework.",
                evidenceIds: ["E1"],
                confidence: 0.75,
              },
            ],
            strengths: ["The artifact is available for structured review."],
            unknowns: [],
          } satisfies IndependentOutput,
          usage: { inputTokens: 0, outputTokens: 0 },
          costUsd,
        };
      }
      if (request.stage === "peer" || request.stage === "revision") {
        return {
          output: {
            ballots: (request.candidates ?? []).map((candidate) => ({
              candidateId: candidate.candidateId,
              stance: "support",
              reason: "The claim is grounded in supplied evidence.",
              evidenceIds: candidate.finding.evidenceIds,
              suggestedSeverity: candidate.finding.severity,
            })),
            missingFindings: [],
            equivalentCandidateGroups: [],
          } satisfies PeerOutput,
          usage: { inputTokens: 0, outputTokens: 0 },
          costUsd,
        };
      }
      const consensus = (request.aggregatedFindings ?? [])
        .filter((finding) => !finding.contested)
        .map((finding) => finding.key);
      const dissent = (request.aggregatedFindings ?? [])
        .filter((finding) => finding.contested)
        .map((finding) => finding.key);
      return {
        output: {
          verdict:
            (request.aggregatedFindings ?? []).length > 0
              ? "needs_changes"
              : "pass",
          summary: "The fake council completed a deterministic review.",
          recommendations:
            (request.aggregatedFindings ?? []).length > 0
              ? ["Verify the evidence-backed findings before proceeding."]
              : [],
          consensusFindingKeys: consensus,
          dissentFindingKeys: dissent,
        } satisfies ChairOutput,
        usage: { inputTokens: 0, outputTokens: 0 },
        costUsd,
      };
    } finally {
      this.active -= 1;
    }
  }
}
