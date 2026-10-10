/**
 * Shared contracts for the hearth (the local control plane) and its ledger.
 *
 * The ledger, the Claude Code hooks, the server, the executor adapters and the
 * dashboard all build against these shapes; the runtime guards that enforce
 * them live in `scripts/hearth/validate.ts`. Source of truth for the model is
 * `docs/plans/command-center/03-target-architecture.md` §4–§6 — change it there
 * in the same PR as any change here.
 *
 * Ledger rows are metadata only (hashes, sizes, names, durations): no prompt,
 * source or tool-output bodies. The two `summary` fields (`verdict.bound` and
 * `council.run.finished`) are the only opt-in bodies, stored redacted and capped.
 */

import type { LoadedConfig } from "../scripts/config/load";
import type {
  ForgePhase,
  ForgeState,
  ReviewFindings,
} from "../scripts/forge/phases";
import type { RunSummary } from "../scripts/forge/runs";

// ── Executors ───────────────────────────────────────────────────────────────

/** Providers the harness drives today. Any other string is allowed (remote workers). */
export const KNOWN_PROVIDERS = [
  "claude",
  "codex",
  "gemini",
  "opencode",
] as const;

export type KnownProvider = (typeof KNOWN_PROVIDERS)[number];

/** A known provider, or any non-empty string a future adapter registers. */
export type Provider = KnownProvider | (string & {});

/**
 * Who is doing the work. Embedded on runs, events, gates and verdicts.
 *
 * `effort` is optional: an interactive session reports its model but not its
 * effort, and a contract that demanded one would make hooks invent values.
 */
export interface Executor {
  provider: Provider;
  model: string;
  effort?: string;
  /** The configured smith that resolved to this executor, when there is one. */
  smith?: string;
  sessionId?: string;
}

/** Policy level that maps work onto smiths. Evaluator rank must be ≥ builder rank. */
export const RANKS = ["apprentice", "journeyman", "master"] as const;

export type Rank = (typeof RANKS)[number];

// ── Evaluators ──────────────────────────────────────────────────────────────

/** What a human who files a verdict is acting as. */
export const EVALUATOR_ACTOR_KINDS = ["operator", "reviewer"] as const;

export type EvaluatorActorKind = (typeof EVALUATOR_ACTOR_KINDS)[number];

/** What shows which provider ran a model evaluator. */
export const PROVIDER_EVIDENCE_SOURCES = [
  "selected-direct-transport",
  "gateway-routing",
] as const;

export type ProviderEvidence = (typeof PROVIDER_EVIDENCE_SOURCES)[number];

/** What shows which model answered as a model evaluator. */
export const MODEL_EVIDENCE_SOURCES = [
  "response-field",
  "gateway-routing",
] as const;

export type ModelEvidence = (typeof MODEL_EVIDENCE_SOURCES)[number];

export const RANK_POLICY_DECISIONS = ["allowed", "rejected"] as const;

export type RankPolicyDecision = (typeof RANK_POLICY_DECISIONS)[number];

/**
 * Who rendered an evaluator verdict (verdict schema 2).
 *
 * A model evaluator keeps what was asked for apart from what ran. The four
 * observed fields are read from a machine source and never copied from the
 * request: all four are present, or none is.
 */
export type EvaluatorIdentity =
  | { kind: "human"; actorKind: EvaluatorActorKind }
  | {
      kind: "model";
      requestedProvider: Provider;
      requestedModel: string;
      requestedRank: Rank;
      observedProvider?: Provider;
      observedModel?: string;
      providerEvidence?: ProviderEvidence;
      modelEvidence?: ModelEvidence;
      rankPolicyDecision: RankPolicyDecision;
      /** The rule that produced the decision. */
      rankPolicyRule: string;
      /** The session the observed values were read for, when there was one. */
      sessionId?: string;
    };

/** A verdict file as evidence: where it was read and the bytes that were read. */
export interface VerdictArtifact {
  /** Relative to the checkout when the file is inside it. */
  path: string;
  /** Lower-case hex SHA-256 of the bytes that were parsed. */
  sha256: string;
  bytes: number;
  /** The verdict schema version those bytes parsed as. */
  schemaVersion: number;
}

/** A named, configured executor: `[smiths.<name>]` in `agent-forge.toml`. */
export interface Smith {
  name: string;
  provider: Provider;
  model: string;
  effort: string;
  enabled: boolean;
  tags: string[];
}

/** Complexity classes a bench is keyed by (the bead's `complexity:*` label). */
export const BENCH_NAMES = ["low", "medium", "high"] as const;

export type BenchName = (typeof BENCH_NAMES)[number];

/** What kind of agent process a session is. */
export const SESSION_KINDS = [
  "interactive",
  "teammate",
  "subagent",
  "headless",
  "remote",
] as const;

export type SessionKind = (typeof SESSION_KINDS)[number];

/** How a session attached to the harness. */
export interface SessionEnvelope {
  /** Provider-issued where available, else a ULID minted by the harness. */
  sessionId: string;
  provider: Provider;
  kind?: SessionKind;
  model?: string;
  effort?: string;
  workspace: string;
  worktree?: string;
  beadId?: string;
  parentSessionId?: string;
}

// ── Queue and reservations ──────────────────────────────────────────────────

/**
 * Derived scheduling state of a bead. The happy path runs in this order;
 * `paused` and `halted` can be entered from any state.
 */
export const QUEUE_STATES = [
  "proposed",
  "approved",
  "queued",
  "running",
  "review",
  "done",
  "paused",
  "halted",
] as const;

export type QueueState = (typeof QUEUE_STATES)[number];

/** A running session's claim on a set of file globs, derived from the bead's file map. */
export interface Reservation {
  beadId: string;
  worktree: string;
  workspace: string;
  globs: string[];
  sessionId?: string;
  /** ISO 8601. */
  acquiredAt: string;
}

// ── Ledger events ───────────────────────────────────────────────────────────

/** Every v1 event kind. Emitters and the UI share this one list. */
export const LEDGER_EVENT_KINDS = [
  "session.started",
  "session.ended",
  "tool.called",
  "prompt.submitted",
  "run.phase.entered",
  "run.phase.completed",
  "review.recorded",
  "gate.ran",
  "verdict.bound",
  "bead.transitioned",
  "reservation.acquired",
  "reservation.released",
  "shift.started",
  "shift.stopped",
  "council.run.started",
  "council.run.finished",
  "friction.recorded",
  "operator.action",
] as const;

export type LedgerEventKind = (typeof LEDGER_EVENT_KINDS)[number];

/** Which surface an `operator.action` came through. */
export const OPERATOR_SURFACES = ["ui", "cli", "mcp", "api"] as const;

export type OperatorSurface = (typeof OPERATOR_SURFACES)[number];

export const SHIFT_STOP_REASONS = [
  "elapsed",
  "operator",
  "throttle",
  "halted",
  "drained",
] as const;

export type ShiftStopReason = (typeof SHIFT_STOP_REASONS)[number];

/** Verdict an evaluator or the council returned for a run. */
export type VerdictOutcome = "pass" | "fail" | "unreadable";

/** Payload per event kind. Metadata only: hashes, sizes, names, durations. */
export interface LedgerPayloads {
  "session.started": {
    source?: string;
    kind?: SessionKind;
    worktree?: string;
    parentSessionId?: string;
  };
  "session.ended": { reason?: string; durationMs?: number };
  "tool.called": {
    tool: string;
    /** Hash of the tool input — never the input itself. */
    argsHash: string;
    durationMs?: number;
    exitCode?: number;
  };
  "prompt.submitted": { hash: string; length: number };
  "run.phase.entered": { phase: ForgePhase };
  "run.phase.completed": { phase: ForgePhase; artifact?: string };
  "review.recorded": {
    phase: ForgePhase;
    round: number;
    verdict: "PASS" | "FAIL" | "UNREADABLE";
    findings: ReviewFindings;
    /** What the review loop decided to do with this round. */
    action?: "advance" | "revise" | "halt";
  };
  "gate.ran": {
    gate: string;
    passed: boolean;
    durationMs?: number;
    exitCode?: number;
    /** The hook event that ran the gate, when known. */
    trigger?: string;
  };
  "verdict.bound": {
    verdict: VerdictOutcome;
    /** The executor that produced the output under review, when known. */
    builder?: Executor;
    /**
     * The model evaluator that was observed to run: a schema 2 verdict's
     * observed provider and model. Absent for a human verdict, for a legacy
     * (schema 1) verdict and when nothing was observed.
     */
    evaluator?: Executor;
    /** The evaluator as a schema 2 verdict declares it. Absent for a legacy verdict. */
    evaluatorIdentity?: EvaluatorIdentity;
    /** The file the verdict was read from, when the emitter hashed what it read. */
    verdictArtifact?: VerdictArtifact;
    /** Opt-in body: redacted and capped by the ledger. */
    summary?: string;
  };
  "bead.transitioned": {
    from: QueueState | null;
    to: QueueState;
    reason?: string;
  };
  "reservation.acquired": { worktree: string; globs: string[] };
  "reservation.released": { worktree: string; globs: string[] };
  "shift.started": {
    shiftId: string;
    concurrency: number;
    durationMs?: number;
    filter?: string;
  };
  "shift.stopped": { shiftId: string; reason: ShiftStopReason };
  "council.run.started": {
    councilRunId: string;
    profile: string;
    budgetUsd?: number;
  };
  "council.run.finished": {
    councilRunId: string;
    outcome: VerdictOutcome | "cancelled";
    costUsd?: number;
    /** Opt-in body: redacted and capped by the ledger. */
    summary?: string;
  };
  /** The friction itself is a Beads chore; this event links it to its cause. */
  "friction.recorded": { frictionBeadId: string; causeEventUlid?: string };
  "operator.action": {
    action: string;
    surface: OperatorSurface;
    target?: string;
  };
}

/** Fields every event carries regardless of kind. */
export interface LedgerEventBase {
  /** ISO 8601. */
  ts: string;
  workspace: string;
  beadId?: string;
  /** The Forge run slug. */
  runId?: string;
  sessionId?: string;
  executor?: Executor;
}

/** What an emitter hands to `appendEvent`; the ledger assigns `id`, `ulid` and (if absent) `ts`. */
export type LedgerEventInput = {
  [K in LedgerEventKind]: Omit<LedgerEventBase, "ts"> & {
    ts?: string;
    kind: K;
    payload: LedgerPayloads[K];
  };
}[LedgerEventKind];

/** A stored (and streamed) event: the input plus the identity the ledger assigned. */
export type LedgerEvent = {
  [K in LedgerEventKind]: LedgerEventBase & {
    /** Autoincrement cursor; SSE deltas and `forge:audit` page by it. */
    id: number;
    ulid: string;
    kind: K;
    payload: LedgerPayloads[K];
  };
}[LedgerEventKind];

/** The narrowed event type for one kind. */
export type LedgerEventOf<K extends LedgerEventKind> = Extract<
  LedgerEvent,
  { kind: K }
>;

// ── Operator API envelope ───────────────────────────────────────────────────

/**
 * Every hearth route, CLI `--json` output and MCP operator tool answers with
 * this envelope — the same `{ ok, data, error }` shape the scripts already use.
 */
export type OperatorEnvelope<T = unknown> =
  | { ok: true; data: T; error: null }
  | { ok: false; data: null; error: string };

// ── Operator API responses ──────────────────────────────────────────────────
//
// What the read routes of the operator API answer as `data`, and what the
// stream sends. Added with the API; every type above this line is unchanged.

/**
 * What the ledger knows about one session, folded from its events. Not a
 * `SessionEnvelope`: nothing here is required beyond the id, because a session
 * whose events named no model has no known provider, and one whose start was
 * compacted away has no start.
 */
export interface SessionSummary {
  sessionId: string;
  workspace: string;
  kind?: SessionKind;
  worktree?: string;
  parentSessionId?: string;
  /** The executor of the newest event that carried one. */
  executor?: Executor;
  /** The bead and run of the newest events that carried them. */
  beadId?: string;
  runId?: string;
  /** ISO 8601; absent when the ledger never saw the session start. */
  startedAt?: string;
  /** ISO 8601 time of the session's newest event. */
  lastEventAt: string;
  /**
   * Present when the session's newest event is `session.ended`. A session
   * that ended without saying so has none: judge staleness by `lastEventAt`.
   */
  endedAt?: string;
}

/** One bead in one queue state, read from its `queue:<state>` label. */
export interface QueueEntry {
  beadId: string;
  title: string;
  state: QueueState;
  /** The bead's own Beads status (`open`, `in_progress`, `closed`, …). */
  status: string;
  priority?: number;
  type?: string;
}

/** A page of ledger events, oldest first. */
export interface EventsPage {
  events: LedgerEvent[];
  /**
   * The id to continue after: the newest id in `events`, or the cursor the
   * request gave (0 without one) when the page is empty.
   */
  cursor: number;
  /**
   * More events matched than the limit. After a cursor, they follow this
   * page; without one, the page is the newest and older ones were left out.
   */
  more: boolean;
}

/** One Forge run: its summary, its stored state and its newest ledger events. */
export interface RunDetail {
  run: RunSummary;
  state: ForgeState;
  events: EventsPage;
}

/** The configured smiths and benches. */
export interface SmithsView {
  smiths: Smith[];
  benches: Record<BenchName, Array<{ smith: string; weight: number }>>;
  /** The smith used when nothing else selects one. */
  defaultSmith: string;
}

/**
 * The first event of `GET /stream`: where the ledger stood, and each
 * collection as the envelope its own read route answers, so one that could
 * not be read carries its own error. `event: delta` messages follow, one
 * `LedgerEvent` each, in `id` order after `cursor`.
 */
export interface StreamSnapshot {
  /** Newest ledger id when the snapshot was taken. */
  cursor: number;
  sessions: OperatorEnvelope<SessionSummary[]>;
  runs: OperatorEnvelope<RunSummary[]>;
  queue: OperatorEnvelope<QueueEntry[]>;
  reservations: OperatorEnvelope<Reservation[]>;
  smiths: OperatorEnvelope<SmithsView>;
  config: OperatorEnvelope<LoadedConfig>;
}
