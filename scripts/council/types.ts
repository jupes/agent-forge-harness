export const COUNCIL_SCHEMA_VERSION = 1 as const;

export const COUNCIL_DEPTHS = ["quick", "balanced", "deep"] as const;
export type CouncilDepth = (typeof COUNCIL_DEPTHS)[number];

export const COUNCIL_STAGES = [
  "independent",
  "peer",
  "revision",
  "chair",
] as const;
export type CouncilStage = (typeof COUNCIL_STAGES)[number];

export const FINDING_SEVERITIES = ["blocker", "high", "medium", "low"] as const;
export type FindingSeverity = (typeof FINDING_SEVERITIES)[number];

export type CouncilSeat = {
  id: string;
  role: string;
  provider: string;
  model: string;
  timeoutMs: number;
  maxOutputTokens: number;
  estimatedCostUsd: number;
  tokenRatesUsdPerMillion?: { input: number; output: number };
};

export type CouncilProfile = {
  schemaVersion: typeof COUNCIL_SCHEMA_VERSION;
  id: string;
  title: string;
  depth: CouncilDepth;
  maxDiscussionRounds?: number;
  minQuorum: number;
  minPeerBallots: number;
  maxEstimatedUsd: number;
  seats: CouncilSeat[];
  chair: CouncilSeat;
};

export type ParseCouncilProfileResult =
  | { ok: true; value: CouncilProfile }
  | { ok: false; error: string };

export type ContextSourceKind = "file" | "plan" | "pr" | "stdin";

export type ContextSourceMetadata = Record<
  string,
  string | number | boolean | string[]
>;

export type ContextSource = {
  kind: ContextSourceKind;
  displayName: string;
  locator: string;
  metadata?: ContextSourceMetadata;
};

export type EvidenceItem = {
  id: string;
  title: string;
  content: string;
  contentHash: string;
  byteLength: number;
  truncated: boolean;
};

export type ContextRedaction = {
  kind: string;
  count: number;
};

export type ContextPack = {
  schemaVersion: typeof COUNCIL_SCHEMA_VERSION;
  source: ContextSource;
  createdAt: string;
  contentHash: string;
  byteLength: number;
  truncated: boolean;
  redactions: ContextRedaction[];
  evidence: EvidenceItem[];
};

export type ProposedFinding = {
  localId: string;
  title: string;
  severity: FindingSeverity;
  claim: string;
  consequence: string;
  evidenceIds: string[];
  confidence: number;
};

export type IndependentOutput = {
  verdict: "pass" | "needs_changes" | "uncertain";
  findings: ProposedFinding[];
  strengths: string[];
  unknowns: string[];
};

export type PeerCandidate = {
  candidateId: string;
  responseLabel: string;
  finding: ProposedFinding;
};

export type PeerBallot = {
  candidateId: string;
  stance: "support" | "oppose" | "uncertain";
  reason: string;
  evidenceIds: string[];
  suggestedSeverity?: FindingSeverity;
};

export type PeerOutput = {
  ballots: PeerBallot[];
  missingFindings: ProposedFinding[];
};

export type AggregatedFinding = {
  key: string;
  title: string;
  claim: string;
  consequence: string;
  severity: FindingSeverity;
  evidenceIds: string[];
  confidence: number;
  proposedBy: number;
  support: number;
  oppose: number;
  uncertain: number;
  contested: boolean;
  reviewed: boolean;
  consensusEligible: boolean;
  resolution: "consensus" | "contested" | "unreviewed" | "rejected";
  independentProposers: number;
  severityDisputed: boolean;
  rationales: Array<{
    reviewerLabel: string;
    stance: PeerBallot["stance"];
    reason: string;
    evidenceIds: string[];
    suggestedSeverity?: FindingSeverity;
  }>;
};

export type ChairOutput = {
  verdict: "pass" | "needs_changes" | "insufficient_evidence";
  summary: string;
  recommendations: string[];
  consensusFindingKeys: string[];
  dissentFindingKeys: string[];
};

export type ModelUsage = {
  inputTokens: number;
  outputTokens: number;
};

export type ModelRequest = {
  runId: string;
  stage: CouncilStage;
  round?: number;
  seat: CouncilSeat;
  system: string;
  prompt: string;
  context: ContextPack;
  candidates?: PeerCandidate[];
  aggregatedFindings?: AggregatedFinding[];
};

export type ModelResult = {
  output: unknown;
  text?: string;
  usage?: ModelUsage;
  costUsd?: number;
  estimatedUsageCostUsd?: number;
};

export class ModelTransportError extends Error {
  readonly usage?: ModelUsage;
  readonly costUsd?: number;
  readonly estimatedUsageCostUsd?: number;

  constructor(
    message: string,
    accounting: {
      usage?: ModelUsage;
      costUsd?: number;
      estimatedUsageCostUsd?: number;
    } = {},
  ) {
    super(message);
    this.name = "ModelTransportError";
    Object.assign(this, accounting);
  }
}

export interface ModelTransport {
  generate(request: ModelRequest, signal: AbortSignal): Promise<ModelResult>;
}

export type CouncilEvent = {
  schemaVersion: typeof COUNCIL_SCHEMA_VERSION;
  runId: string;
  seq: number;
  at: string;
  type: string;
  payload: Record<string, unknown>;
};

export type SeatRecord = {
  stage: CouncilStage;
  round?: number;
  seatId: string;
  provider: string;
  model: string;
  status: "completed" | "failed" | "cancelled";
  latencyMs: number;
  output?: IndependentOutput | PeerOutput | ChairOutput;
  usage?: ModelUsage;
  costUsd?: number;
  estimatedUsageCostUsd?: number;
  accountedCostUsd: number;
  error?: string;
};

export type CouncilRun = {
  schemaVersion: typeof COUNCIL_SCHEMA_VERSION;
  runId: string;
  status: "completed" | "failed" | "cancelled";
  startedAt: string;
  finishedAt: string;
  profile: CouncilProfile;
  context: {
    source: ContextSource;
    contentHash: string;
    byteLength: number;
    truncated: boolean;
    redactions: ContextRedaction[];
  };
  estimatedCostUsd: number;
  actualCostUsd: number | null;
  usageEstimatedCostUsd: number | null;
  accountedCostUsd: number;
  costIsEstimate: boolean;
  limitations: string[];
  records: SeatRecord[];
  aggregatedFindings: AggregatedFinding[];
  chair?: ChairOutput;
  failures: Array<{
    stage: CouncilStage;
    seatId: string;
    error: string;
  }>;
  error?: string;
  events: CouncilEvent[];
};

export type CouncilExecutionResult =
  | { ok: true; run: CouncilRun }
  | { ok: false; run: CouncilRun; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function parseSeat(value: unknown, path: string): CouncilSeat | string {
  if (!isRecord(value)) return `${path} must be an object`;
  const stringFields = ["id", "role", "provider", "model"] as const;
  for (const field of stringFields) {
    const fieldValue = value[field];
    if (typeof fieldValue !== "string" || fieldValue.trim() === "") {
      return `${path}.${field} must be a non-empty string`;
    }
  }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(value.id as string)) {
    return `${path}.id must be kebab-case`;
  }
  if (!isPositiveInt(value.timeoutMs)) {
    return `${path}.timeoutMs must be a positive integer`;
  }
  if (!isPositiveInt(value.maxOutputTokens)) {
    return `${path}.maxOutputTokens must be a positive integer`;
  }
  if (!isNonNegativeNumber(value.estimatedCostUsd)) {
    return `${path}.estimatedCostUsd must be a non-negative number`;
  }
  if (
    value.tokenRatesUsdPerMillion !== undefined &&
    (!isRecord(value.tokenRatesUsdPerMillion) ||
      !isNonNegativeNumber(value.tokenRatesUsdPerMillion.input) ||
      !isNonNegativeNumber(value.tokenRatesUsdPerMillion.output))
  ) {
    return `${path}.tokenRatesUsdPerMillion must contain non-negative input and output rates`;
  }
  return {
    id: (value.id as string).trim(),
    role: (value.role as string).trim(),
    provider: (value.provider as string).trim(),
    model: (value.model as string).trim(),
    timeoutMs: value.timeoutMs,
    maxOutputTokens: value.maxOutputTokens,
    estimatedCostUsd: value.estimatedCostUsd,
    ...(value.tokenRatesUsdPerMillion === undefined
      ? {}
      : {
          tokenRatesUsdPerMillion: value.tokenRatesUsdPerMillion as {
            input: number;
            output: number;
          },
        }),
  };
}

export function parseCouncilProfileJson(
  text: string,
): ParseCouncilProfileResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch {
    return { ok: false, error: "invalid JSON" };
  }
  if (!isRecord(raw)) return { ok: false, error: "root must be an object" };
  if (raw.schemaVersion !== COUNCIL_SCHEMA_VERSION) {
    return { ok: false, error: "schemaVersion must be 1" };
  }
  if (typeof raw.id !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(raw.id)) {
    return { ok: false, error: "id must be kebab-case" };
  }
  if (typeof raw.title !== "string" || raw.title.trim() === "") {
    return { ok: false, error: "title must be a non-empty string" };
  }
  if (
    typeof raw.depth !== "string" ||
    !COUNCIL_DEPTHS.includes(raw.depth as CouncilDepth)
  ) {
    return {
      ok: false,
      error: `depth must be one of ${COUNCIL_DEPTHS.join("|")}`,
    };
  }
  if (!Array.isArray(raw.seats) || raw.seats.length < 2) {
    return { ok: false, error: "seats must contain at least two seats" };
  }
  const seats: CouncilSeat[] = [];
  const ids = new Set<string>();
  for (let index = 0; index < raw.seats.length; index += 1) {
    const parsed = parseSeat(raw.seats[index], `seats[${index}]`);
    if (typeof parsed === "string") return { ok: false, error: parsed };
    if (ids.has(parsed.id)) {
      return { ok: false, error: `duplicate seat id: ${parsed.id}` };
    }
    ids.add(parsed.id);
    seats.push(parsed);
  }
  const chair = parseSeat(raw.chair, "chair");
  if (typeof chair === "string") return { ok: false, error: chair };
  if (ids.has(chair.id)) {
    return { ok: false, error: "chair.id must not duplicate a seat id" };
  }
  if (
    !isPositiveInt(raw.minQuorum) ||
    raw.minQuorum < 2 ||
    raw.minQuorum > seats.length
  ) {
    return {
      ok: false,
      error: `minQuorum must be an integer between 2 and ${seats.length}`,
    };
  }
  if (
    typeof raw.minPeerBallots !== "number" ||
    !Number.isInteger(raw.minPeerBallots) ||
    raw.minPeerBallots < 0 ||
    raw.minPeerBallots > seats.length
  ) {
    return {
      ok: false,
      error: `minPeerBallots must be an integer between 0 and ${seats.length}`,
    };
  }
  if (raw.depth !== "quick" && raw.minPeerBallots < 1) {
    return {
      ok: false,
      error: "deliberative profiles require at least one peer ballot",
    };
  }
  if (raw.depth !== "quick" && raw.minPeerBallots >= seats.length) {
    return {
      ok: false,
      error: `minPeerBallots cannot exceed ${seats.length - 1} independent peers; authors cannot vote for their own findings`,
    };
  }
  if (
    raw.maxDiscussionRounds !== undefined &&
    (raw.depth !== "deep" ||
      !isPositiveInt(raw.maxDiscussionRounds) ||
      raw.maxDiscussionRounds > 3)
  ) {
    return {
      ok: false,
      error:
        "maxDiscussionRounds requires a deep profile and must be between 1 and 3",
    };
  }
  if (!isNonNegativeNumber(raw.maxEstimatedUsd)) {
    return {
      ok: false,
      error: "maxEstimatedUsd must be a non-negative number",
    };
  }
  return {
    ok: true,
    value: {
      schemaVersion: COUNCIL_SCHEMA_VERSION,
      id: raw.id,
      title: raw.title.trim(),
      depth: raw.depth as CouncilDepth,
      ...(raw.depth === "deep"
        ? {
            maxDiscussionRounds:
              (raw.maxDiscussionRounds as number | undefined) ?? 1,
          }
        : {}),
      minQuorum: raw.minQuorum,
      minPeerBallots: raw.minPeerBallots,
      maxEstimatedUsd: raw.maxEstimatedUsd,
      seats,
      chair,
    },
  };
}

export function estimateCouncilCost(profile: CouncilProfile): number {
  const seatRoundCost = profile.seats.reduce(
    (total, seat) => total + seat.estimatedCostUsd,
    0,
  );
  const rounds =
    profile.depth === "quick"
      ? 1
      : profile.depth === "deep"
        ? 2 + (profile.maxDiscussionRounds ?? 1)
        : 2;
  return Number(
    (seatRoundCost * rounds + profile.chair.estimatedCostUsd).toFixed(6),
  );
}
