/**
 * What each event kind may store. The ledger is metadata only: a payload is
 * cut down to these keys before it is written, so a body handed in under any
 * other key never reaches the file.
 */

import type { LedgerEventKind } from "../../types/hearth";

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
/** Both kinds of `EvaluatorIdentity`: a human has the first two, a model all but `actorKind`. */
const EVALUATOR_IDENTITY_KEYS = [
  "kind",
  "actorKind",
  "requestedProvider",
  "requestedModel",
  "requestedRank",
  "observedProvider",
  "observedModel",
  "providerEvidence",
  "modelEvidence",
  "rankPolicyDecision",
  "rankPolicyRule",
  "sessionId",
];
const VERDICT_ARTIFACT_KEYS = ["path", "sha256", "bytes", "schemaVersion"];

/** Payload keys whose value is an object or array, and the shape each is cut to. */
const NESTED: Readonly<Record<string, (value: unknown) => unknown>> = {
  builder: (value) => pick(value, EXECUTOR_KEYS),
  evaluator: (value) => pick(value, EXECUTOR_KEYS),
  evaluatorIdentity: (value) => pick(value, EVALUATOR_IDENTITY_KEYS),
  verdictArtifact: (value) => pick(value, VERDICT_ARTIFACT_KEYS),
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
 * values are cut to their own shape, and anything that is not a scalar under a
 * scalar key is dropped too.
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
    if (nested) out[key] = nested(value);
    else if (isScalar(value)) out[key] = value;
  }
  return out;
}
