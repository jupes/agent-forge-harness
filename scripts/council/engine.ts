import { randomUUID } from "crypto";
import { hashText, renderContextForPrompt, sanitizeContent } from "./context";
import {
  type AggregatedFinding,
  type ChairOutput,
  COUNCIL_SCHEMA_VERSION,
  type ContextPack,
  type CouncilEvent,
  type CouncilExecutionResult,
  type CouncilProfile,
  type CouncilRun,
  type CouncilSeat,
  type CouncilStage,
  estimateCouncilCost,
  FINDING_SEVERITIES,
  type FindingSeverity,
  type IndependentOutput,
  type ModelRequest,
  type ModelResult,
  type ModelTransport,
  type PeerBallot,
  type PeerCandidate,
  type PeerOutput,
  type ProposedFinding,
  type SeatRecord,
} from "./types";

const SEVERITY_RANK: Record<FindingSeverity, number> = {
  blocker: 0,
  high: 1,
  medium: 2,
  low: 3,
};

export type CouncilEngineOptions = {
  profile: CouncilProfile;
  context: ContextPack;
  resolveTransport: (seat: CouncilSeat) => ModelTransport;
  signal?: AbortSignal;
  maxUsd?: number;
  runId?: string;
  now?: () => Date;
  onEvent?: (event: CouncilEvent) => void;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

function isSeverity(value: unknown): value is FindingSeverity {
  return (
    typeof value === "string" &&
    FINDING_SEVERITIES.includes(value as FindingSeverity)
  );
}

function cleanModelText(value: string): string {
  return sanitizeContent(value.trim(), "redact").text;
}

function validateEvidenceIds(
  evidenceIds: string[],
  validEvidenceIds: ReadonlySet<string>,
  path: string,
  allowEmpty = false,
): void {
  if (!allowEmpty && evidenceIds.length === 0) {
    throw new Error(`${path} must cite at least one evidence ID`);
  }
  for (const evidenceId of evidenceIds) {
    if (!validEvidenceIds.has(evidenceId)) {
      throw new Error(`${path} contains unknown evidence ID: ${evidenceId}`);
    }
  }
}

function parseFinding(
  value: unknown,
  path: string,
  validEvidenceIds: ReadonlySet<string>,
): ProposedFinding {
  if (!isRecord(value)) throw new Error(`${path} must be an object`);
  const stringFields = ["localId", "title", "claim", "consequence"] as const;
  for (const field of stringFields) {
    if (typeof value[field] !== "string" || value[field].trim() === "") {
      throw new Error(`${path}.${field} must be a non-empty string`);
    }
  }
  if (!isSeverity(value.severity)) {
    throw new Error(`${path}.severity must be a known severity`);
  }
  if (!isStringArray(value.evidenceIds)) {
    throw new Error(`${path}.evidenceIds must be a string array`);
  }
  validateEvidenceIds(
    value.evidenceIds,
    validEvidenceIds,
    `${path}.evidenceIds`,
  );
  if (
    typeof value.confidence !== "number" ||
    !Number.isFinite(value.confidence) ||
    value.confidence < 0 ||
    value.confidence > 1
  ) {
    throw new Error(`${path}.confidence must be a number from 0 to 1`);
  }
  return {
    localId: cleanModelText(value.localId as string),
    title: cleanModelText(value.title as string),
    severity: value.severity,
    claim: cleanModelText(value.claim as string),
    consequence: cleanModelText(value.consequence as string),
    evidenceIds: value.evidenceIds,
    confidence: value.confidence,
  };
}

function parseIndependentOutput(
  value: unknown,
  validEvidenceIds: ReadonlySet<string>,
): IndependentOutput {
  if (!isRecord(value)) throw new Error("independent output must be an object");
  if (
    value.verdict !== "pass" &&
    value.verdict !== "needs_changes" &&
    value.verdict !== "uncertain"
  ) {
    throw new Error("independent verdict is invalid");
  }
  if (!Array.isArray(value.findings)) {
    throw new Error("independent findings must be an array");
  }
  if (!isStringArray(value.strengths) || !isStringArray(value.unknowns)) {
    throw new Error("independent strengths and unknowns must be string arrays");
  }
  return {
    verdict: value.verdict,
    findings: value.findings.map((finding, index) =>
      parseFinding(finding, `findings[${index}]`, validEvidenceIds),
    ),
    strengths: value.strengths.map(cleanModelText),
    unknowns: value.unknowns.map(cleanModelText),
  };
}

function parsePeerBallot(
  value: unknown,
  path: string,
  validEvidenceIds: ReadonlySet<string>,
): PeerBallot {
  if (!isRecord(value)) throw new Error(`${path} must be an object`);
  if (typeof value.candidateId !== "string" || value.candidateId === "") {
    throw new Error(`${path}.candidateId must be a non-empty string`);
  }
  if (
    value.stance !== "support" &&
    value.stance !== "oppose" &&
    value.stance !== "uncertain"
  ) {
    throw new Error(`${path}.stance is invalid`);
  }
  if (typeof value.reason !== "string" || value.reason.trim() === "") {
    throw new Error(`${path}.reason must be a non-empty string`);
  }
  if (!isStringArray(value.evidenceIds)) {
    throw new Error(`${path}.evidenceIds must be a string array`);
  }
  validateEvidenceIds(
    value.evidenceIds,
    validEvidenceIds,
    `${path}.evidenceIds`,
    true,
  );
  if (
    value.suggestedSeverity !== undefined &&
    !isSeverity(value.suggestedSeverity)
  ) {
    throw new Error(`${path}.suggestedSeverity is invalid`);
  }
  const ballot: PeerBallot = {
    candidateId: value.candidateId,
    stance: value.stance,
    reason: cleanModelText(value.reason),
    evidenceIds: value.evidenceIds,
  };
  if (value.suggestedSeverity !== undefined) {
    ballot.suggestedSeverity = value.suggestedSeverity;
  }
  return ballot;
}

function parsePeerOutput(
  value: unknown,
  validEvidenceIds: ReadonlySet<string>,
  validCandidateIds: ReadonlySet<string>,
): PeerOutput {
  if (!isRecord(value)) throw new Error("peer output must be an object");
  if (!Array.isArray(value.ballots) || !Array.isArray(value.missingFindings)) {
    throw new Error("peer ballots and missingFindings must be arrays");
  }
  const ballots = value.ballots.map((ballot, index) =>
    parsePeerBallot(ballot, `ballots[${index}]`, validEvidenceIds),
  );
  const seenCandidates = new Set<string>();
  for (const ballot of ballots) {
    if (!validCandidateIds.has(ballot.candidateId)) {
      throw new Error(
        `ballot contains unknown candidate ID: ${ballot.candidateId}`,
      );
    }
    if (seenCandidates.has(ballot.candidateId)) {
      throw new Error(
        `ballot contains duplicate candidate ID: ${ballot.candidateId}`,
      );
    }
    seenCandidates.add(ballot.candidateId);
  }
  if (seenCandidates.size !== validCandidateIds.size) {
    throw new Error(
      `peer output must ballot every candidate (${seenCandidates.size}/${validCandidateIds.size})`,
    );
  }
  return {
    ballots,
    missingFindings: value.missingFindings.map((finding, index) =>
      parseFinding(finding, `missingFindings[${index}]`, validEvidenceIds),
    ),
  };
}

function parseChairOutput(
  value: unknown,
  findings: AggregatedFinding[],
): ChairOutput {
  if (!isRecord(value)) throw new Error("chair output must be an object");
  if (
    value.verdict !== "pass" &&
    value.verdict !== "needs_changes" &&
    value.verdict !== "insufficient_evidence"
  ) {
    throw new Error("chair verdict is invalid");
  }
  if (typeof value.summary !== "string" || value.summary.trim() === "") {
    throw new Error("chair summary must be a non-empty string");
  }
  if (
    !isStringArray(value.recommendations) ||
    !isStringArray(value.consensusFindingKeys) ||
    !isStringArray(value.dissentFindingKeys)
  ) {
    throw new Error("chair list fields must be string arrays");
  }
  const validKeys = new Set(findings.map((finding) => finding.key));
  const classifiedKeys = [
    ...value.consensusFindingKeys,
    ...value.dissentFindingKeys,
  ];
  const uniqueKeys = new Set(classifiedKeys);
  if (uniqueKeys.size !== classifiedKeys.length) {
    throw new Error("chair finding keys must not be duplicated or overlap");
  }
  for (const key of uniqueKeys) {
    if (!validKeys.has(key)) {
      throw new Error(`chair output contains unknown finding key: ${key}`);
    }
  }
  if (uniqueKeys.size !== validKeys.size) {
    throw new Error(
      `chair output must classify every finding (${uniqueKeys.size}/${validKeys.size})`,
    );
  }
  const dissent = new Set(value.dissentFindingKeys);
  for (const finding of findings) {
    if (
      finding.contested &&
      (finding.severity === "blocker" || finding.severity === "high") &&
      !dissent.has(finding.key)
    ) {
      throw new Error(
        `contested ${finding.severity} finding must remain in dissent: ${finding.key}`,
      );
    }
  }
  return {
    verdict: value.verdict,
    summary: cleanModelText(value.summary),
    recommendations: value.recommendations.map(cleanModelText),
    consensusFindingKeys: value.consensusFindingKeys,
    dissentFindingKeys: value.dissentFindingKeys,
  };
}

function safeError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return sanitizeContent(raw.slice(0, 800), "redact").text;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function anonymizeText(value: string, profile: CouncilProfile): string {
  const identities = [
    ...profile.seats.flatMap((seat) => [
      seat.id,
      seat.role,
      seat.provider,
      seat.model,
    ]),
    profile.chair.id,
    profile.chair.role,
    profile.chair.provider,
    profile.chair.model,
  ]
    .filter((identity) => identity.trim().length >= 3)
    .sort((a, b) => b.length - a.length);
  let result = value;
  for (const identity of identities) {
    result = result.replace(
      new RegExp(escapeRegExp(identity), "gi"),
      "[identity removed]",
    );
  }
  return result;
}

function anonymizeFinding(
  finding: ProposedFinding,
  localId: string,
  profile: CouncilProfile,
): ProposedFinding {
  return {
    localId,
    title: anonymizeText(finding.title, profile),
    severity: finding.severity,
    claim: anonymizeText(finding.claim, profile),
    consequence: anonymizeText(finding.consequence, profile),
    evidenceIds: finding.evidenceIds,
    confidence: finding.confidence,
  };
}

function findingFingerprint(finding: ProposedFinding): string {
  const normalized = [
    finding.title,
    finding.claim,
    finding.consequence,
    [...finding.evidenceIds].sort().join(","),
  ]
    .join("|")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
  return hashText(normalized).slice(0, 16);
}

function deterministicOrder<T>(values: T[], seed: string): T[] {
  return values
    .map((value, index) => ({
      value,
      sortKey: hashText(`${seed}|${index}`),
    }))
    .sort((left, right) => left.sortKey.localeCompare(right.sortKey))
    .map((entry) => entry.value);
}

function responseLabel(index: number): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  return alphabet[index] ?? `R${index + 1}`;
}

type IndependentSuccess = SeatRecord & {
  stage: "independent";
  status: "completed";
  output: IndependentOutput;
};

function isIndependentSuccess(
  record: SeatRecord,
): record is IndependentSuccess {
  return (
    record.stage === "independent" &&
    record.status === "completed" &&
    record.output !== undefined &&
    "findings" in record.output
  );
}

function preparePeerCandidates(
  successes: IndependentSuccess[],
  reviewer: CouncilSeat,
  profile: CouncilProfile,
  runId: string,
): { candidates: PeerCandidate[]; fingerprints: Map<string, string> } {
  const ordered = deterministicOrder(successes, `${runId}|${reviewer.id}`);
  const candidates: PeerCandidate[] = [];
  const fingerprints = new Map<string, string>();
  ordered.forEach((record, responseIndex) => {
    const label = `Response ${responseLabel(responseIndex)}`;
    record.output.findings.forEach((finding, findingIndex) => {
      const candidateId = `${responseLabel(responseIndex)}-F${findingIndex + 1}`;
      candidates.push({
        candidateId,
        responseLabel: label,
        finding: anonymizeFinding(finding, `F${findingIndex + 1}`, profile),
      });
      fingerprints.set(candidateId, findingFingerprint(finding));
    });
  });
  return { candidates, fingerprints };
}

function independentSystem(seat: CouncilSeat): string {
  return [
    "You are one independent member of a review council.",
    `Your assigned lens is: ${seat.role}`,
    "Do not assume other reviewers will catch problems for you.",
    "Return only the requested structured object. Do not reveal provider or model identity.",
  ].join("\n");
}

function independentPrompt(context: ContextPack): string {
  return [
    "Review the artifact independently. Identify only evidence-backed findings.",
    "Use severity blocker|high|medium|low and confidence from 0 to 1.",
    "Output: {verdict, findings:[{localId,title,severity,claim,consequence,evidenceIds,confidence}], strengths, unknowns}.",
    renderContextForPrompt(context),
  ].join("\n\n");
}

function peerSystem(seat: CouncilSeat): string {
  return [
    "You are an anonymous peer reviewer in a review council.",
    `Apply this lens: ${seat.role}`,
    "Judge claims by evidence rather than style or presumed identity.",
    "Return only the requested structured object.",
  ].join("\n");
}

function peerPrompt(context: ContextPack, candidates: PeerCandidate[]): string {
  return [
    "Challenge the anonymous candidate findings below.",
    "For every candidateId, return support, oppose, or uncertain with a concise reason and evidence IDs.",
    "You may suggest a corrected severity and add genuinely missing findings.",
    "Output: {ballots:[{candidateId,stance,reason,evidenceIds,suggestedSeverity?}], missingFindings:[...]}.",
    `<anonymous_candidates>\n${JSON.stringify(candidates)}\n</anonymous_candidates>`,
    renderContextForPrompt(context),
  ].join("\n\n");
}

function chairSystem(): string {
  return [
    "You are the independent chair of a review council.",
    "Synthesize the deterministic aggregate; do not invent votes or evidence.",
    "Contested blocker/high findings must appear in dissent unless explicitly resolved by evidence.",
    "Return only the requested structured object.",
  ].join("\n");
}

function chairPrompt(
  context: ContextPack,
  aggregatedFindings: AggregatedFinding[],
  failures: CouncilRun["failures"],
): string {
  return [
    "Produce the final council review.",
    "Output: {verdict,summary,recommendations,consensusFindingKeys,dissentFindingKeys}.",
    `<aggregate>\n${JSON.stringify({ aggregatedFindings, failures })}\n</aggregate>`,
    `Artifact source: ${context.source.kind} ${context.source.displayName}; evidence IDs: ${context.evidence.map((item) => item.id).join(", ")}.`,
  ].join("\n\n");
}

async function generateWithDeadline(
  transport: ModelTransport,
  request: ModelRequest,
  outerSignal: AbortSignal | undefined,
): Promise<ModelResult> {
  const controller = new AbortController();
  let timeoutReached = false;
  let outerAborted = false;
  const onOuterAbort = (): void => {
    outerAborted = true;
    controller.abort();
  };
  if (outerSignal?.aborted) onOuterAbort();
  outerSignal?.addEventListener("abort", onOuterAbort, { once: true });

  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timeoutReached = true;
      controller.abort();
      reject(new Error(`timeout after ${request.seat.timeoutMs}ms`));
    }, request.seat.timeoutMs);
  });
  const cancelled = new Promise<never>((_, reject) => {
    if (outerAborted) {
      reject(new Error("council run cancelled"));
      return;
    }
    controller.signal.addEventListener(
      "abort",
      () => {
        if (!timeoutReached) reject(new Error("council run cancelled"));
      },
      { once: true },
    );
  });

  try {
    return await Promise.race([
      transport.generate(request, controller.signal),
      deadline,
      cancelled,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    outerSignal?.removeEventListener("abort", onOuterAbort);
  }
}

type ParseOutput<T extends IndependentOutput | PeerOutput | ChairOutput> = (
  value: unknown,
) => T;

async function callSeat<T extends IndependentOutput | PeerOutput | ChairOutput>(
  request: ModelRequest,
  resolveTransport: (seat: CouncilSeat) => ModelTransport,
  parseOutput: ParseOutput<T>,
  signal: AbortSignal | undefined,
  emit: (type: string, payload: Record<string, unknown>) => CouncilEvent,
): Promise<SeatRecord> {
  emit("seat.started", {
    stage: request.stage,
    seatId: request.seat.id,
    provider: request.seat.provider,
    model: request.seat.model,
  });
  const started = performance.now();
  let reportedUsage: ModelResult["usage"];
  let reportedCostUsd: number | undefined;
  try {
    const transport = resolveTransport(request.seat);
    const result = await generateWithDeadline(transport, request, signal);
    if (result.usage) {
      if (
        !Number.isInteger(result.usage.inputTokens) ||
        result.usage.inputTokens < 0 ||
        !Number.isInteger(result.usage.outputTokens) ||
        result.usage.outputTokens < 0
      ) {
        throw new Error("transport returned invalid token usage");
      }
      reportedUsage = result.usage;
    }
    if (result.costUsd !== undefined) {
      if (!Number.isFinite(result.costUsd) || result.costUsd < 0) {
        throw new Error("transport returned invalid cost");
      }
      reportedCostUsd = result.costUsd;
    }
    const output = parseOutput(result.output);
    const record: SeatRecord = {
      stage: request.stage,
      seatId: request.seat.id,
      provider: request.seat.provider,
      model: request.seat.model,
      status: "completed",
      latencyMs: Math.round(performance.now() - started),
      output,
    };
    if (reportedUsage) record.usage = reportedUsage;
    if (reportedCostUsd !== undefined) record.costUsd = reportedCostUsd;
    emit("seat.completed", {
      stage: request.stage,
      seatId: request.seat.id,
      latencyMs: record.latencyMs,
    });
    return record;
  } catch (error) {
    const cancelled = signal?.aborted === true;
    const message = safeError(error);
    const record: SeatRecord = {
      stage: request.stage,
      seatId: request.seat.id,
      provider: request.seat.provider,
      model: request.seat.model,
      status: cancelled ? "cancelled" : "failed",
      latencyMs: Math.round(performance.now() - started),
      error: message,
    };
    if (reportedUsage) record.usage = reportedUsage;
    if (reportedCostUsd !== undefined) record.costUsd = reportedCostUsd;
    emit(cancelled ? "seat.cancelled" : "seat.failed", {
      stage: request.stage,
      seatId: request.seat.id,
      error: message,
    });
    return record;
  }
}

type MutableAggregate = {
  representative: ProposedFinding;
  proposedBy: number;
  confidenceTotal: number;
  severities: FindingSeverity[];
  support: number;
  oppose: number;
  uncertain: number;
};

function aggregateFindings(
  independent: IndependentSuccess[],
  peers: SeatRecord[],
  candidateMaps: Map<string, Map<string, string>>,
): AggregatedFinding[] {
  const aggregates = new Map<string, MutableAggregate>();
  const addProposal = (finding: ProposedFinding): string => {
    const key = findingFingerprint(finding);
    const existing = aggregates.get(key);
    if (existing) {
      existing.proposedBy += 1;
      existing.confidenceTotal += finding.confidence;
      existing.severities.push(finding.severity);
    } else {
      aggregates.set(key, {
        representative: finding,
        proposedBy: 1,
        confidenceTotal: finding.confidence,
        severities: [finding.severity],
        support: 0,
        oppose: 0,
        uncertain: 0,
      });
    }
    return key;
  };

  for (const record of independent) {
    for (const finding of record.output.findings) addProposal(finding);
  }

  for (const record of peers) {
    if (
      record.status !== "completed" ||
      record.output === undefined ||
      !("ballots" in record.output)
    ) {
      continue;
    }
    const mapping = candidateMaps.get(record.seatId);
    if (!mapping) continue;
    const reviewerVotes = new Map<
      string,
      { stances: PeerBallot["stance"][]; severities: FindingSeverity[] }
    >();
    for (const ballot of record.output.ballots) {
      const key = mapping.get(ballot.candidateId);
      if (!key) continue;
      const vote = reviewerVotes.get(key) ?? { stances: [], severities: [] };
      vote.stances.push(ballot.stance);
      if (ballot.suggestedSeverity) {
        vote.severities.push(ballot.suggestedSeverity);
      }
      reviewerVotes.set(key, vote);
    }
    for (const [key, vote] of reviewerVotes) {
      const target = aggregates.get(key);
      if (!target) continue;
      const stance = vote.stances.includes("oppose")
        ? "oppose"
        : vote.stances.includes("uncertain")
          ? "uncertain"
          : "support";
      target[stance] += 1;
      target.severities.push(...vote.severities);
    }
    for (const finding of record.output.missingFindings) addProposal(finding);
  }

  return [...aggregates.entries()]
    .map(([key, aggregate]) => {
      const severity = [...aggregate.severities].sort(
        (left, right) => SEVERITY_RANK[left] - SEVERITY_RANK[right],
      )[0]!;
      return {
        key,
        title: aggregate.representative.title,
        claim: aggregate.representative.claim,
        consequence: aggregate.representative.consequence,
        severity,
        evidenceIds: [...new Set(aggregate.representative.evidenceIds)].sort(),
        confidence: Number(
          (aggregate.confidenceTotal / aggregate.proposedBy).toFixed(3),
        ),
        proposedBy: aggregate.proposedBy,
        support: aggregate.support,
        oppose: aggregate.oppose,
        uncertain: aggregate.uncertain,
        contested: aggregate.oppose > 0 || aggregate.uncertain > 0,
      };
    })
    .sort((left, right) => {
      const severity =
        SEVERITY_RANK[left.severity] - SEVERITY_RANK[right.severity];
      if (severity !== 0) return severity;
      if (left.support !== right.support) return right.support - left.support;
      return left.title.localeCompare(right.title);
    });
}

function reportedCost(records: SeatRecord[]): number {
  return Number(
    records
      .reduce((total, record) => total + (record.costUsd ?? 0), 0)
      .toFixed(6),
  );
}

function finalRun(
  status: CouncilRun["status"],
  startedAt: string,
  profile: CouncilProfile,
  context: ContextPack,
  runId: string,
  estimatedCostUsd: number,
  records: SeatRecord[],
  aggregatedFindings: AggregatedFinding[],
  events: CouncilEvent[],
  now: () => Date,
  chair: ChairOutput | undefined,
  error: string | undefined,
): CouncilRun {
  const run: CouncilRun = {
    schemaVersion: COUNCIL_SCHEMA_VERSION,
    runId,
    status,
    startedAt,
    finishedAt: now().toISOString(),
    profile,
    context: {
      source: context.source,
      contentHash: context.contentHash,
      byteLength: context.byteLength,
      truncated: context.truncated,
      redactions: context.redactions,
    },
    estimatedCostUsd,
    actualCostUsd: reportedCost(records),
    records,
    aggregatedFindings,
    failures: records
      .filter((record) => record.status !== "completed")
      .map((record) => ({
        stage: record.stage,
        seatId: record.seatId,
        error: record.error ?? record.status,
      })),
    events,
  };
  if (chair) run.chair = chair;
  if (error) run.error = error;
  return run;
}

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
  const independentRecords = await Promise.all(
    options.profile.seats.map((seat) =>
      callSeat(
        {
          runId,
          stage: "independent",
          seat,
          system: independentSystem(seat),
          prompt: independentPrompt(options.context),
          context: options.context,
        },
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
  const candidateMaps = new Map<string, Map<string, string>>();
  if (options.profile.depth === "balanced") {
    emit("stage.started", {
      stage: "peer",
      seatCount: independentSuccesses.length,
    });
    const peerCalls = independentSuccesses.map((record) => {
      const seat = options.profile.seats.find(
        (candidate) => candidate.id === record.seatId,
      )!;
      const prepared = preparePeerCandidates(
        independentSuccesses,
        seat,
        options.profile,
        runId,
      );
      candidateMaps.set(seat.id, prepared.fingerprints);
      return callSeat(
        {
          runId,
          stage: "peer",
          seat,
          system: peerSystem(seat),
          prompt: peerPrompt(options.context, prepared.candidates),
          context: options.context,
          candidates: prepared.candidates,
        },
        options.resolveTransport,
        (value) =>
          parsePeerOutput(
            value,
            new Set(options.context.evidence.map((item) => item.id)),
            new Set(
              prepared.candidates.map((candidate) => candidate.candidateId),
            ),
          ),
        options.signal,
        emit,
      );
    });
    peerRecords.push(...(await Promise.all(peerCalls)));
    records.push(...peerRecords);
    emit("stage.completed", {
      stage: "peer",
      completed: peerRecords.filter((record) => record.status === "completed")
        .length,
      failed: peerRecords.filter((record) => record.status !== "completed")
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
    const validPeerBallots = peerRecords.filter(
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
    candidateMaps,
  );
  emit("findings.aggregated", {
    count: aggregatedFindings.length,
    contested: aggregatedFindings.filter((finding) => finding.contested).length,
  });

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
    ),
    context: options.context,
    aggregatedFindings,
  };
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
  );
  return { ok: true, run };
}

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
      if (request.stage === "peer") {
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
