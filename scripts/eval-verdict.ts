/**
 * Parser for `.tmp/work/<TASK-ID>-verdict.json` (Evaluator strict gate).
 * @see .claude/protocols/evaluation-verdict.md
 */

export const EVAL_VERDICT_SCHEMA_VERSION = 1 as const;

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

export type EvalVerdictParsed = {
  schemaVersion: typeof EVAL_VERDICT_SCHEMA_VERSION;
  taskId: string;
  verdict: "PASS" | "FAIL";
  findings: {
    blocker: number;
    high: number;
    medium: number;
    low: number;
  };
  summary?: string;
  attestations?: EvalAttestations;
};

export type ParseEvalVerdictResult =
  | { ok: true; value: EvalVerdictParsed }
  | { ok: false; error: string };

function isNonNegInt(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && n >= 0;
}

function isStampScore(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= 5;
}

/**
 * Parse and validate evaluator verdict JSON. Strict schema v1 only.
 */
export function parseEvalVerdictJson(text: string): ParseEvalVerdictResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch {
    return { ok: false, error: "invalid JSON" };
  }
  if (typeof raw !== "object" || raw === null) {
    return { ok: false, error: "root must be an object" };
  }
  const o = raw as Record<string, unknown>;
  if (o.schemaVersion !== EVAL_VERDICT_SCHEMA_VERSION) {
    return { ok: false, error: "schemaVersion must be 1" };
  }
  if (typeof o.taskId !== "string" || o.taskId.trim() === "") {
    return { ok: false, error: "taskId must be a non-empty string" };
  }
  if (o.verdict !== "PASS" && o.verdict !== "FAIL") {
    return { ok: false, error: 'verdict must be "PASS" or "FAIL"' };
  }
  const f = o.findings;
  if (typeof f !== "object" || f === null) {
    return { ok: false, error: "findings must be an object" };
  }
  const fr = f as Record<string, unknown>;
  if (
    !isNonNegInt(fr.blocker) ||
    !isNonNegInt(fr.high) ||
    !isNonNegInt(fr.medium) ||
    !isNonNegInt(fr.low)
  ) {
    return { ok: false, error: "findings.blocker|high|medium|low must be non-negative integers" };
  }
  const value: EvalVerdictParsed = {
    schemaVersion: EVAL_VERDICT_SCHEMA_VERSION,
    taskId: o.taskId.trim(),
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
    return { ok: false, error: "summary must be a string when present" };
  }
  if (o.attestations !== undefined) {
    if (typeof o.attestations !== "object" || o.attestations === null || Array.isArray(o.attestations)) {
      return { ok: false, error: "attestations must be an object when present" };
    }
    const src = o.attestations as Record<string, unknown>;
    const attestations: EvalAttestations = {};
    for (const key of Object.keys(src)) {
      if (!ATTESTATION_DIMENSIONS.includes(key as AttestationDimension)) {
        return {
          ok: false,
          error: `attestations.${key} is not a known dimension (${ATTESTATION_DIMENSIONS.join("|")})`,
        };
      }
      const v = src[key];
      if (!isStampScore(v)) {
        return {
          ok: false,
          error: `attestations.${key} must be an integer 0..5`,
        };
      }
      attestations[key as AttestationDimension] = v;
    }
    if (Object.keys(attestations).length > 0) {
      value.attestations = attestations;
    }
  }
  return { ok: true, value };
}

/**
 * When strict gate is on: FAIL with any BLOCKER or HIGH finding blocks completion hooks / ship path.
 * PASS always allowed; FAIL with only MEDIUM/LOW does not block (follow-up beads instead).
 */
export function verdictBlocksShip(value: EvalVerdictParsed): boolean {
  if (value.verdict === "PASS") return false;
  return value.findings.blocker > 0 || value.findings.high > 0;
}
