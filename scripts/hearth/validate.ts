/**
 * Runtime guards for the hearth contracts in `types/hearth.ts`.
 *
 * Hand-written and dependency-free: the ledger validates what hooks and remote
 * workers hand it, the server validates what the wire delivers, and the UI
 * validates what the stream sends back. Unknown extra keys are tolerated so a
 * newer emitter does not break an older reader; wrong or missing known keys are
 * not.
 */

import {
  BENCH_NAMES,
  type Executor,
  LEDGER_EVENT_KINDS,
  type LedgerEvent,
  type LedgerEventInput,
  type LedgerEventKind,
  OPERATOR_SURFACES,
  type OperatorEnvelope,
  QUEUE_STATES,
  type QueueState,
  type Reservation,
  SESSION_KINDS,
  type SessionEnvelope,
  SHIFT_STOP_REASONS,
  type Smith,
} from "../../types/hearth";

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

/** A check returns an error message, or `null` when the value is acceptable. */
type Check = (value: unknown, path: string) => string | null;

const ISO_8601 =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

const str: Check = (v, path) =>
  typeof v === "string" ? null : `${path}: expected string, got ${describe(v)}`;

const nonEmptyStr: Check = (v, path) =>
  typeof v === "string" && v.length > 0
    ? null
    : `${path}: expected non-empty string, got ${describe(v)}`;

const bool: Check = (v, path) =>
  typeof v === "boolean"
    ? null
    : `${path}: expected boolean, got ${describe(v)}`;

const num: Check = (v, path) =>
  typeof v === "number" && Number.isFinite(v)
    ? null
    : `${path}: expected finite number, got ${describe(v)}`;

const nonNegInt: Check = (v, path) =>
  typeof v === "number" && Number.isInteger(v) && v >= 0
    ? null
    : `${path}: expected non-negative integer`;

const posInt: Check = (v, path) =>
  typeof v === "number" && Number.isInteger(v) && v > 0
    ? null
    : `${path}: expected positive integer`;

const isoTimestamp: Check = (v, path) =>
  typeof v === "string" && ISO_8601.test(v) && !Number.isNaN(Date.parse(v))
    ? null
    : `${path}: expected ISO 8601 timestamp`;

function oneOf(allowed: readonly string[]): Check {
  return (v, path) =>
    typeof v === "string" && allowed.includes(v)
      ? null
      : `${path}: expected one of ${allowed.join(" | ")}`;
}

function optional(check: Check): Check {
  return (v, path) => (v === undefined ? null : check(v, path));
}

function nullable(check: Check): Check {
  return (v, path) => (v === null ? null : check(v, path));
}

function arrayOf(check: Check): Check {
  return (v, path) => {
    if (!Array.isArray(v)) return `${path}: expected array, got ${describe(v)}`;
    for (let i = 0; i < v.length; i++) {
      const error = check(v[i], `${path}[${i}]`);
      if (error) return error;
    }
    return null;
  };
}

/** An object whose listed keys satisfy their checks; unlisted keys are ignored. */
function shape(fields: Record<string, Check>): Check {
  return (v, path) => {
    if (!isRecord(v)) return `${path}: expected object, got ${describe(v)}`;
    for (const [key, check] of Object.entries(fields)) {
      const error = check(v[key], `${path}.${key}`);
      if (error) return error;
    }
    return null;
  };
}

function guard<T>(
  check: Check,
  label: string,
): (value: unknown) => ValidationResult<T> {
  return (value) => {
    const error = check(value, label);
    // justification: `check` has proven the structure `T` describes.
    return error === null
      ? { ok: true, value: value as T }
      : { ok: false, error };
  };
}

// ── Executors, smiths, sessions ─────────────────────────────────────────────

const executorCheck = shape({
  provider: nonEmptyStr,
  model: nonEmptyStr,
  effort: optional(nonEmptyStr),
  smith: optional(nonEmptyStr),
  sessionId: optional(nonEmptyStr),
});

const smithCheck = shape({
  name: nonEmptyStr,
  provider: nonEmptyStr,
  model: nonEmptyStr,
  effort: nonEmptyStr,
  enabled: bool,
  tags: arrayOf(str),
});

const sessionEnvelopeCheck = shape({
  sessionId: nonEmptyStr,
  provider: nonEmptyStr,
  kind: optional(oneOf(SESSION_KINDS)),
  model: optional(nonEmptyStr),
  effort: optional(nonEmptyStr),
  workspace: nonEmptyStr,
  worktree: optional(nonEmptyStr),
  beadId: optional(nonEmptyStr),
  parentSessionId: optional(nonEmptyStr),
});

const reservationCheck = shape({
  beadId: nonEmptyStr,
  worktree: nonEmptyStr,
  workspace: nonEmptyStr,
  globs: arrayOf(nonEmptyStr),
  sessionId: optional(nonEmptyStr),
  acquiredAt: isoTimestamp,
});

export const validateExecutor = guard<Executor>(executorCheck, "executor");
export const validateSmith = guard<Smith>(smithCheck, "smith");
export const validateSessionEnvelope = guard<SessionEnvelope>(
  sessionEnvelopeCheck,
  "session",
);
export const validateReservation = guard<Reservation>(
  reservationCheck,
  "reservation",
);

export function isQueueState(value: unknown): value is QueueState {
  return (
    typeof value === "string" &&
    (QUEUE_STATES as readonly string[]).includes(value)
  );
}

/** Complexity class a bench is keyed by. */
export function isBenchName(
  value: unknown,
): value is (typeof BENCH_NAMES)[number] {
  return (
    typeof value === "string" &&
    (BENCH_NAMES as readonly string[]).includes(value)
  );
}

// ── Ledger events ───────────────────────────────────────────────────────────

const phase = oneOf(["research", "plan", "implement", "ship"]);
const queueState = oneOf(QUEUE_STATES);
const verdictOutcome = oneOf(["pass", "fail", "unreadable"]);

/** One entry per kind: adding a kind to `LEDGER_EVENT_KINDS` fails typecheck until it has a check. */
const PAYLOAD_CHECKS: Record<LedgerEventKind, Check> = {
  "session.started": shape({
    source: optional(str),
    kind: optional(oneOf(SESSION_KINDS)),
    worktree: optional(nonEmptyStr),
    parentSessionId: optional(nonEmptyStr),
  }),
  "session.ended": shape({
    reason: optional(str),
    durationMs: optional(nonNegInt),
  }),
  "tool.called": shape({
    tool: nonEmptyStr,
    argsHash: nonEmptyStr,
    durationMs: optional(nonNegInt),
    exitCode: optional(num),
  }),
  "prompt.submitted": shape({ hash: nonEmptyStr, length: nonNegInt }),
  "run.phase.entered": shape({ phase }),
  "run.phase.completed": shape({ phase, artifact: optional(str) }),
  "review.recorded": shape({
    phase,
    round: posInt,
    verdict: oneOf(["PASS", "FAIL", "UNREADABLE"]),
    findings: shape({
      blocker: nonNegInt,
      high: nonNegInt,
      medium: nonNegInt,
      low: nonNegInt,
    }),
    action: optional(oneOf(["advance", "revise", "halt"])),
  }),
  "gate.ran": shape({
    gate: nonEmptyStr,
    passed: bool,
    durationMs: optional(nonNegInt),
    exitCode: optional(num),
    trigger: optional(nonEmptyStr),
  }),
  "verdict.bound": shape({
    verdict: verdictOutcome,
    builder: optional(executorCheck),
    evaluator: optional(executorCheck),
    summary: optional(str),
  }),
  "bead.transitioned": shape({
    from: nullable(queueState),
    to: queueState,
    reason: optional(str),
  }),
  "reservation.acquired": shape({
    worktree: nonEmptyStr,
    globs: arrayOf(nonEmptyStr),
  }),
  "reservation.released": shape({
    worktree: nonEmptyStr,
    globs: arrayOf(nonEmptyStr),
  }),
  "shift.started": shape({
    shiftId: nonEmptyStr,
    concurrency: posInt,
    durationMs: optional(nonNegInt),
    filter: optional(str),
  }),
  "shift.stopped": shape({
    shiftId: nonEmptyStr,
    reason: oneOf(SHIFT_STOP_REASONS),
  }),
  "council.run.started": shape({
    councilRunId: nonEmptyStr,
    profile: nonEmptyStr,
    budgetUsd: optional(num),
  }),
  "council.run.finished": shape({
    councilRunId: nonEmptyStr,
    outcome: oneOf(["pass", "fail", "unreadable", "cancelled"]),
    costUsd: optional(num),
    summary: optional(str),
  }),
  "friction.recorded": shape({
    frictionBeadId: nonEmptyStr,
    causeEventUlid: optional(nonEmptyStr),
  }),
  "operator.action": shape({
    action: nonEmptyStr,
    surface: oneOf(OPERATOR_SURFACES),
    target: optional(nonEmptyStr),
  }),
};

const CORRELATION = {
  workspace: nonEmptyStr,
  beadId: optional(nonEmptyStr),
  runId: optional(nonEmptyStr),
  sessionId: optional(nonEmptyStr),
  executor: optional(executorCheck),
};

function eventCheck(stored: boolean): Check {
  const envelope = shape({
    ...CORRELATION,
    ...(stored
      ? { id: posInt, ulid: nonEmptyStr, ts: isoTimestamp }
      : { ts: optional(isoTimestamp) }),
  });
  return (value, path) => {
    const error = envelope(value, path);
    if (error) return error;
    const record = value as Record<string, unknown>;
    const kind = record.kind;
    if (
      typeof kind !== "string" ||
      !(LEDGER_EVENT_KINDS as readonly string[]).includes(kind)
    ) {
      return `${path}.kind: expected one of ${LEDGER_EVENT_KINDS.join(" | ")}`;
    }
    // The kind is in the error so a failing emitter is identifiable from the message alone.
    return PAYLOAD_CHECKS[kind as LedgerEventKind](
      record.payload,
      `${path}(${kind}).payload`,
    );
  };
}

/** What an emitter hands to `appendEvent`, before the ledger assigns `id` and `ulid`. */
export const validateLedgerEventInput = guard<LedgerEventInput>(
  eventCheck(false),
  "event",
);

/** A stored or streamed event, including the identity the ledger assigned. */
export const validateLedgerEvent = guard<LedgerEvent>(
  eventCheck(true),
  "event",
);

// ── Operator envelope ───────────────────────────────────────────────────────

/**
 * The `{ ok, data, error }` envelope. `ok` must agree with the rest: success
 * carries `error: null`; failure carries `data: null` and a message.
 */
export function validateOperatorEnvelope(
  value: unknown,
): ValidationResult<OperatorEnvelope> {
  if (!isRecord(value))
    return {
      ok: false,
      error: `envelope: expected object, got ${describe(value)}`,
    };
  const { ok, data, error } = value;
  if (typeof ok !== "boolean")
    return { ok: false, error: "envelope.ok: expected boolean" };
  if (ok) {
    if (error !== null)
      return {
        ok: false,
        error: "envelope.error: must be null when ok is true",
      };
    if (data === undefined)
      return { ok: false, error: "envelope.data: required when ok is true" };
  } else {
    if (data !== null)
      return {
        ok: false,
        error: "envelope.data: must be null when ok is false",
      };
    if (typeof error !== "string" || error.length === 0) {
      return {
        ok: false,
        error: "envelope.error: expected non-empty string when ok is false",
      };
    }
  }
  // justification: the branches above pin `data`/`error` to the discriminated union's shape.
  return { ok: true, value: value as OperatorEnvelope };
}
