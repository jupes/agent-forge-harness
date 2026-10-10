/**
 * What each event kind may store. The ledger is metadata only: a payload is
 * cut down to these keys before it is written, so a body handed in under any
 * other key never reaches the file.
 */

import type { LedgerEventKind } from "../../types/hearth";
import { parseEvaluatorIdentity } from "../eval-verdict";

/** One entry per kind: adding a kind to `LEDGER_EVENT_KINDS` fails typecheck until it has a list. */
export const PAYLOAD_KEYS: Record<LedgerEventKind, readonly string[]> = {
  "session.started": ["source", "kind", "worktree", "parentSessionId"],
  "session.ended": ["reason", "durationMs"],
  "tool.called": ["tool", "argsHash", "durationMs", "exitCode"],
  "prompt.submitted": ["hash", "length"],
  "run.phase.entered": ["phase"],
  "run.phase.completed": ["phase", "artifact"],
  "review.recorded": ["phase", "round", "verdict", "findings", "action"],
  "gate.ran": ["gate", "passed", "durationMs", "exitCode", "trigger"],
  "verdict.bound": [
    "verdict",
    "builder",
    "evaluator",
    "evaluatorIdentity",
    "verdictArtifact",
    "summary",
  ],
  "bead.transitioned": ["from", "to", "reason"],
  "reservation.acquired": ["worktree", "globs"],
  "reservation.released": ["worktree", "globs"],
  "shift.started": ["shiftId", "concurrency", "durationMs", "filter"],
  "shift.stopped": ["shiftId", "reason"],
  "council.run.started": ["councilRunId", "profile", "budgetUsd"],
  "council.run.finished": ["councilRunId", "outcome", "costUsd", "summary"],
  "friction.recorded": ["frictionBeadId", "causeEventUlid"],
  "operator.action": ["action", "surface", "target"],
};

const EXECUTOR_KEYS = ["provider", "model", "effort", "smith", "sessionId"];
const FINDING_KEYS = ["blocker", "high", "medium", "low"];
const VERDICT_ARTIFACT_KEYS = ["path", "sha256", "bytes", "schemaVersion"];
const SHA256_HEX = /^[0-9a-f]{64}$/;

/** Returned by a nested cut for a value that is not worth storing under its key. */
const DROP = Symbol("drop");

/** An evaluator identity as the verdict parser reads it, or nothing: never a half-valid one. */
function evaluatorIdentity(value: unknown): unknown {
  if (typeof value !== "object" || value === null) return DROP;
  // A copy of the value's own properties: nothing inherited is read.
  const parsed = parseEvaluatorIdentity({ ...value });
  return parsed.ok ? parsed.value : DROP;
}

/** A verdict file reference with a real digest and size, or nothing. */
function verdictArtifact(value: unknown): unknown {
  const cut = pick(value, VERDICT_ARTIFACT_KEYS);
  const { path, sha256, bytes, schemaVersion } = cut;
  return typeof path === "string" &&
    path.length > 0 &&
    typeof sha256 === "string" &&
    SHA256_HEX.test(sha256) &&
    typeof bytes === "number" &&
    Number.isInteger(bytes) &&
    bytes >= 0 &&
    typeof schemaVersion === "number" &&
    Number.isInteger(schemaVersion)
    ? cut
    : DROP;
}

/** Payload keys whose value is an object or array, and the shape each is cut to. */
const NESTED: Readonly<Record<string, (value: unknown) => unknown>> = {
  builder: (value) => pick(value, EXECUTOR_KEYS),
  evaluator: (value) => pick(value, EXECUTOR_KEYS),
  evaluatorIdentity,
  verdictArtifact,
  findings: (value) => pick(value, FINDING_KEYS),
  globs: (value) =>
    Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string")
      : [],
};

function isScalar(value: unknown): boolean {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

/** The listed keys of an object, scalars only. */
function pick(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (typeof value !== "object" || value === null) return out;
  const record = value as Record<string, unknown>;
  for (const key of keys) {
    if (record[key] !== undefined && isScalar(record[key]))
      out[key] = record[key];
  }
  return out;
}

/**
 * A payload reduced to its kind's allowlist. Unknown keys are dropped, nested
 * values are cut to their own shape (an evaluator identity or a verdict
 * artifact that is not well formed is dropped whole), and anything that is not
 * a scalar under a scalar key is dropped too.
 */
export function stripPayload(
  kind: LedgerEventKind,
  payload: unknown,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (typeof payload !== "object" || payload === null) return out;
  const record = payload as Record<string, unknown>;
  for (const key of PAYLOAD_KEYS[kind]) {
    const value = record[key];
    if (value === undefined) continue;
    const nested = NESTED[key];
    if (nested) {
      const cut = nested(value);
      if (cut !== DROP) out[key] = cut;
    } else if (isScalar(value)) out[key] = value;
  }
  return out;
}
