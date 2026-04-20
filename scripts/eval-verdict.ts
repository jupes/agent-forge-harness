/**
 * Parser for `.tmp/work/<TASK-ID>-verdict.json` (Evaluator strict gate).
 * @see .claude/protocols/evaluation-verdict.md
 */

export const EVAL_VERDICT_SCHEMA_VERSION = 1 as const;

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
};

export type ParseEvalVerdictResult =
  | { ok: true; value: EvalVerdictParsed }
  | { ok: false; error: string };

function isNonNegInt(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && n >= 0;
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
