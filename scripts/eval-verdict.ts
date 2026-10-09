/**
 * The evaluator verdict file: its schema and what makes it one run's verdict.
 *
 * Schema 2 names the Beads issue and the execution run it judges, and who
 * judged. Schema 1 named only a task and is still read, as a legacy verdict:
 * it is never one run's verdict and never names an evaluator.
 *
 * Nothing here touches disk; where the file lives and how it is written and
 * read is `eval-verdict-store.ts`.
 *
 * @see .claude/protocols/evaluation-verdict.md
 */

import {
  EVALUATOR_ACTOR_KINDS,
  type EvaluatorActorKind,
  type EvaluatorIdentity,
  type Executor,
  MODEL_EVIDENCE_SOURCES,
  type ModelEvidence,
  PROVIDER_EVIDENCE_SOURCES,
  type ProviderEvidence,
  RANK_POLICY_DECISIONS,
  RANKS,
  type Rank,
  type RankPolicyDecision,
} from "../types/hearth";
import { isValidSlug } from "./forge/runs";
import { type BeadsIssueId, parseBeadsIssueId } from "./run-correlation";

export const EVAL_VERDICT_SCHEMA_VERSION = 2 as const;

/** The schema that named a task and nothing else. Read, never written. */
export const LEGACY_EVAL_VERDICT_SCHEMA_VERSION = 1 as const;

/**
 * Named dimensions allowed in `attestations` (Gas Town / Wasteland "stamps" analog).
 * Scores are integers in [0, 5]. All fields are optional; extras are rejected.
 */
export const ATTESTATION_DIMENSIONS = [
  "quality",
  "reliability",
  "creativity",
  "maintainability",
  "ux",
] as const;
export type AttestationDimension = (typeof ATTESTATION_DIMENSIONS)[number];

export type EvalAttestations = Partial<Record<AttestationDimension, number>>;

export interface EvalFindings {
  blocker: number;
  high: number;
  medium: number;
  low: number;
}

/** What every verdict says, whatever its schema. */
export interface EvalVerdictBody {
  verdict: "PASS" | "FAIL";
  findings: EvalFindings;
  summary?: string;
  attestations?: EvalAttestations;
}

/** A schema 1 verdict: a task id, and nothing about the run or the evaluator. */
export type LegacyEvalVerdict = EvalVerdictBody & {
  schemaVersion: typeof LEGACY_EVAL_VERDICT_SCHEMA_VERSION;
  taskId: string;
};

export type EvalVerdict = EvalVerdictBody & {
  schemaVersion: typeof EVAL_VERDICT_SCHEMA_VERSION;
  beadsIssueId: BeadsIssueId;
  /** The Forge run id: the run correlation's `executionRunId`. */
  executionRunId: string;
  evaluator: EvaluatorIdentity;
};

export type EvalVerdictParsed = LegacyEvalVerdict | EvalVerdict;

export type ParseEvalVerdictResult =
  | { ok: true; value: EvalVerdictParsed }
  | { ok: false; error: string };

type Fields = Readonly<Record<string, unknown>>;

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

function refuse(error: string): { ok: false; error: string } {
  return { ok: false, error };
}

function isRecord(value: unknown): value is Fields {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonNegInt(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && n >= 0;
}

function isStampScore(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= 5;
}

/** A non-empty string, trimmed, or undefined. */
function nonEmpty(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function oneOf<T extends string>(
  allowed: readonly T[],
  value: unknown,
): T | undefined {
  return allowed.find((item) => item === value);
}

function bodyFrom(o: Fields): Parsed<EvalVerdictBody> {
  if (o.verdict !== "PASS" && o.verdict !== "FAIL") {
    return refuse('verdict must be "PASS" or "FAIL"');
  }
  const fr = o.findings;
  if (!isRecord(fr)) return refuse("findings must be an object");
  if (
    !isNonNegInt(fr.blocker) ||
    !isNonNegInt(fr.high) ||
    !isNonNegInt(fr.medium) ||
    !isNonNegInt(fr.low)
  ) {
    return refuse(
      "findings.blocker|high|medium|low must be non-negative integers",
    );
  }
  const value: EvalVerdictBody = {
    verdict: o.verdict,
    findings: {
      blocker: fr.blocker,
      high: fr.high,
      medium: fr.medium,
      low: fr.low,
    },
  };
  if (typeof o.summary === "string") {
    value.summary = o.summary;
  } else if (o.summary !== undefined) {
    return refuse("summary must be a string when present");
  }
  if (o.attestations !== undefined) {
    if (!isRecord(o.attestations)) {
      return refuse("attestations must be an object when present");
    }
    const attestations: EvalAttestations = {};
    for (const [key, score] of Object.entries(o.attestations)) {
      const dimension = oneOf(ATTESTATION_DIMENSIONS, key);
      if (dimension === undefined) {
        return refuse(
          `attestations.${key} is not a known dimension (${ATTESTATION_DIMENSIONS.join("|")})`,
        );
      }
      if (!isStampScore(score)) {
        return refuse(`attestations.${key} must be an integer 0..5`);
      }
      attestations[dimension] = score;
    }
    if (Object.keys(attestations).length > 0) {
      value.attestations = attestations;
    }
  }
  return { ok: true, value };
}

const OBSERVED_FIELDS = [
  "observedProvider",
  "observedModel",
  "providerEvidence",
  "modelEvidence",
] as const;

/** What a model evaluator was observed to be: all four fields, or nothing. */
function observedFrom(o: Fields): Parsed<{
  observedProvider: string;
  observedModel: string;
  providerEvidence: ProviderEvidence;
  modelEvidence: ModelEvidence;
} | null> {
  const present = OBSERVED_FIELDS.filter((name) => o[name] !== undefined);
  if (present.length === 0) return { ok: true, value: null };
  if (present.length !== OBSERVED_FIELDS.length) {
    return refuse(
      "evaluator observedProvider, observedModel, providerEvidence and modelEvidence must all be present or all absent",
    );
  }
  const observedProvider = nonEmpty(o.observedProvider);
  const observedModel = nonEmpty(o.observedModel);
  if (observedProvider === undefined || observedModel === undefined) {
    return refuse(
      "evaluator observedProvider and observedModel must be non-empty strings",
    );
  }
  const providerEvidence = oneOf(PROVIDER_EVIDENCE_SOURCES, o.providerEvidence);
  if (providerEvidence === undefined) {
    return refuse(
      `evaluator providerEvidence must be ${PROVIDER_EVIDENCE_SOURCES.join(" or ")}`,
    );
  }
  const modelEvidence = oneOf(MODEL_EVIDENCE_SOURCES, o.modelEvidence);
  if (modelEvidence === undefined) {
    return refuse(
      `evaluator modelEvidence must be ${MODEL_EVIDENCE_SOURCES.join(" or ")}`,
    );
  }
  return {
    ok: true,
    value: { observedProvider, observedModel, providerEvidence, modelEvidence },
  };
}

/** A typed evaluator, with only the contract's fields kept. */
export function parseEvaluatorIdentity(
  raw: unknown,
): Parsed<EvaluatorIdentity> {
  if (!isRecord(raw)) return refuse("evaluator must be an object");
  if (raw.kind === "human") {
    const actorKind: EvaluatorActorKind | undefined = oneOf(
      EVALUATOR_ACTOR_KINDS,
      raw.actorKind,
    );
    if (actorKind === undefined) {
      return refuse(
        `evaluator actorKind must be ${EVALUATOR_ACTOR_KINDS.join(" or ")}`,
      );
    }
    return { ok: true, value: { kind: "human", actorKind } };
  }
  if (raw.kind !== "model") {
    return refuse('evaluator kind must be "human" or "model"');
  }
  const requestedProvider = nonEmpty(raw.requestedProvider);
  const requestedModel = nonEmpty(raw.requestedModel);
  if (requestedProvider === undefined || requestedModel === undefined) {
    return refuse(
      "evaluator requestedProvider and requestedModel must be non-empty strings",
    );
  }
  const requestedRank: Rank | undefined = oneOf(RANKS, raw.requestedRank);
  if (requestedRank === undefined) {
    return refuse(`evaluator requestedRank must be ${RANKS.join(", ")}`);
  }
  const rankPolicyDecision: RankPolicyDecision | undefined = oneOf(
    RANK_POLICY_DECISIONS,
    raw.rankPolicyDecision,
  );
  if (rankPolicyDecision === undefined) {
    return refuse(
      `evaluator rankPolicyDecision must be ${RANK_POLICY_DECISIONS.join(" or ")}`,
    );
  }
  const rankPolicyRule = nonEmpty(raw.rankPolicyRule);
  if (rankPolicyRule === undefined) {
    return refuse("evaluator rankPolicyRule must be a non-empty string");
  }
  const observed = observedFrom(raw);
  if (!observed.ok) return observed;
  const sessionId = nonEmpty(raw.sessionId);
  if (raw.sessionId !== undefined && sessionId === undefined) {
    return refuse(
      "evaluator sessionId must be a non-empty string when present",
    );
  }
  return {
    ok: true,
    value: {
      kind: "model",
      requestedProvider,
      requestedModel,
      requestedRank,
      ...(observed.value ?? {}),
      rankPolicyDecision,
      rankPolicyRule,
      ...(sessionId !== undefined ? { sessionId } : {}),
    },
  };
}

/**
 * Parse and validate evaluator verdict JSON: schema 2, or schema 1 as a legacy
 * verdict. This is the file's shape only; whether a verdict is one run's, and
 * whether its evaluator satisfies strict completion, are `verdictForRun` and
 * `strictEvaluatorProblem`.
 */
export function parseEvalVerdictJson(text: string): ParseEvalVerdictResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch {
    return refuse("invalid JSON");
  }
  if (!isRecord(raw)) return refuse("root must be an object");

  if (raw.schemaVersion === LEGACY_EVAL_VERDICT_SCHEMA_VERSION) {
    const taskId = nonEmpty(raw.taskId);
    if (taskId === undefined) {
      return refuse("taskId must be a non-empty string");
    }
    const body = bodyFrom(raw);
    if (!body.ok) return body;
    return {
      ok: true,
      value: {
        schemaVersion: LEGACY_EVAL_VERDICT_SCHEMA_VERSION,
        taskId,
        ...body.value,
      },
    };
  }
  if (raw.schemaVersion !== EVAL_VERDICT_SCHEMA_VERSION) {
    return refuse(
      `schemaVersion must be ${EVAL_VERDICT_SCHEMA_VERSION} (or ${LEGACY_EVAL_VERDICT_SCHEMA_VERSION}, legacy)`,
    );
  }

  const beadsIssueId = parseBeadsIssueId(raw.beadsIssueId);
  if (beadsIssueId === null) {
    return refuse("beadsIssueId must be a Beads issue id");
  }
  const executionRunId = nonEmpty(raw.executionRunId) ?? "";
  if (!isValidSlug(executionRunId)) {
    return refuse("executionRunId must be a Forge run id");
  }
  const body = bodyFrom(raw);
  if (!body.ok) return body;
  const evaluator = parseEvaluatorIdentity(raw.evaluator);
  if (!evaluator.ok) return evaluator;
  return {
    ok: true,
    value: {
      schemaVersion: EVAL_VERDICT_SCHEMA_VERSION,
      beadsIssueId,
      executionRunId,
      ...body.value,
      evaluator: evaluator.value,
    },
  };
}

/**
 * `verdict` as the verdict of one run: schema 2, naming that run and, when the
 * run names a bead, that bead. A legacy verdict is nobody's: it names no run.
 */
export function verdictForRun(
  verdict: EvalVerdictParsed,
  run: { beadsIssueId?: string; executionRunId: string },
): Parsed<EvalVerdict> {
  if (verdict.schemaVersion !== EVAL_VERDICT_SCHEMA_VERSION) {
    return refuse(
      "the verdict is schema 1 (legacy): it names no run and no evaluator",
    );
  }
  if (verdict.executionRunId !== run.executionRunId) {
    return refuse(
      `verdict executionRunId "${verdict.executionRunId}" is not this run ("${run.executionRunId}")`,
    );
  }
  if (
    run.beadsIssueId !== undefined &&
    verdict.beadsIssueId !== run.beadsIssueId
  ) {
    return refuse(
      `verdict beadsIssueId "${verdict.beadsIssueId}" is not this run's bead ("${run.beadsIssueId}")`,
    );
  }
  return { ok: true, value: verdict };
}

/**
 * The model evaluator that was observed to run, as an executor. Undefined for
 * a human and for a model verdict with nothing observed: the requested
 * provider and model are never used in its place.
 */
export function observedExecutor(
  evaluator: EvaluatorIdentity,
): Executor | undefined {
  if (
    evaluator.kind !== "model" ||
    evaluator.observedProvider === undefined ||
    evaluator.observedModel === undefined
  ) {
    return undefined;
  }
  return {
    provider: evaluator.observedProvider,
    model: evaluator.observedModel,
    ...(evaluator.sessionId !== undefined
      ? { sessionId: evaluator.sessionId }
      : {}),
  };
}

/**
 * When strict gate is on: FAIL with any BLOCKER or HIGH finding blocks completion hooks / ship path.
 * PASS always allowed; FAIL with only MEDIUM/LOW does not block (follow-up beads instead).
 */
export function verdictBlocksShip(value: EvalVerdictBody): boolean {
  if (value.verdict === "PASS") return false;
  return value.findings.blocker > 0 || value.findings.high > 0;
}
