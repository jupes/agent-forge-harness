/**
 * Promptfoo JavaScript assertions for the evaluator calibration harness.
 *
 * These are loaded via `file://assertions.ts:<fn>` entries in
 * `scripts/evals/promptfooconfig.yaml`. They reuse the shared verdict parser
 * in `scripts/eval-verdict.ts` so schema rules stay aligned with the
 * strict quality-gate hook.
 *
 * `fixture_expected` is a small JSON string in the test's `vars` that tells
 * the assertion what verdict / severity floors to require. Shape:
 *
 *   {"verdict":"PASS","blocker":0,"high":0}
 *   {"verdict":"FAIL","blocker_min":1}
 *   {"verdict":"FAIL","blocker":0,"high":0,"medium_min":1}
 */

import { parseEvalVerdictJson } from "../eval-verdict";

type PromptfooContext = {
  vars?: {
    task_id?: unknown;
    fixture_expected?: unknown;
    [k: string]: unknown;
  };
};

type AssertionResult = { pass: boolean; reason?: string; score?: number };

type FixtureExpectation = {
  verdict: "PASS" | "FAIL";
  blocker?: number;
  high?: number;
  medium?: number;
  low?: number;
  blocker_min?: number;
  high_min?: number;
  medium_min?: number;
  low_min?: number;
};

export function parseFixtureExpectation(raw: unknown): FixtureExpectation | null {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const o = parsed as Record<string, unknown>;
  if (o.verdict !== "PASS" && o.verdict !== "FAIL") return null;
  const out: FixtureExpectation = { verdict: o.verdict };
  for (const k of ["blocker", "high", "medium", "low", "blocker_min", "high_min", "medium_min", "low_min"] as const) {
    const v = o[k];
    if (v === undefined) continue;
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0) return null;
    out[k] = v;
  }
  return out;
}

export function checkVerdictMatchesSchema(output: string): AssertionResult {
  const parsed = parseEvalVerdictJson(output);
  if (!parsed.ok) return { pass: false, reason: parsed.error };
  return { pass: true };
}

export function checkVerdictMatchesFixture(output: string, ctx: PromptfooContext): AssertionResult {
  const parsed = parseEvalVerdictJson(output);
  if (!parsed.ok) return { pass: false, reason: `schema: ${parsed.error}` };

  const taskId = typeof ctx.vars?.task_id === "string" ? ctx.vars.task_id : undefined;
  if (taskId && parsed.value.taskId !== taskId) {
    return {
      pass: false,
      reason: `taskId "${parsed.value.taskId}" !== fixture task_id "${taskId}"`,
    };
  }

  const expected = parseFixtureExpectation(ctx.vars?.fixture_expected);
  if (!expected) {
    return { pass: false, reason: "fixture_expected missing or invalid" };
  }
  if (parsed.value.verdict !== expected.verdict) {
    return {
      pass: false,
      reason: `verdict ${parsed.value.verdict} !== expected ${expected.verdict}`,
    };
  }
  const f = parsed.value.findings;
  const mismatches: string[] = [];
  for (const k of ["blocker", "high", "medium", "low"] as const) {
    const exact = expected[k];
    if (exact !== undefined && f[k] !== exact) {
      mismatches.push(`${k}=${f[k]} (expected exactly ${exact})`);
    }
    const min = expected[`${k}_min` as const];
    if (min !== undefined && f[k] < min) {
      mismatches.push(`${k}=${f[k]} (expected >= ${min})`);
    }
  }
  if (mismatches.length > 0) {
    return { pass: false, reason: mismatches.join("; ") };
  }
  return { pass: true };
}

// Promptfoo assertion entrypoints (the value returned by the javascript assert
// is used as `pass`; returning an object with `pass`/`reason` is supported).

export function verdictMatchesSchema(output: string): AssertionResult {
  return checkVerdictMatchesSchema(output);
}

export function verdictMatchesFixture(output: string, ctx: PromptfooContext): AssertionResult {
  return checkVerdictMatchesFixture(output, ctx);
}
