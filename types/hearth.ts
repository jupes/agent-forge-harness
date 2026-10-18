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
/**
 * A smith model that names none: the provider CLI runs the model it is
 * configured with, and no `--model` is passed (`modelArgs`, x1gs.4.9). The
 * ledger records the smith's model as this word unless the provider's stream
 * names the model it ran.
 */
export const CLI_DEFAULT_MODEL = "default";

export interface Smith {
  name: string;
  provider: Provider;
  /** The provider's model id, or `CLI_DEFAULT_MODEL`. */
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

/** A bead's queue state is the one label made of this prefix and a state. */
export const QUEUE_LABEL_PREFIX = "queue:";

/**
 * Metadata the queue writes with the label, in the same `bd` call: the state
 * again. A label counts as a state only when this agrees with it, because a
 * child bead inherits its parent's labels and not its metadata.
 */
export const QUEUE_STATE_KEY = "queue_state";

/** Metadata on a paused bead: the state it was paused from, and returns to. */
export const QUEUE_RESUME_KEY = "queue_resume";

/** What can be asked of a bead in the queue; the table in `scripts/scheduler/queue.ts` says when. */
export const QUEUE_ACTIONS = [
  "propose",
  "approve",
  "queue",
  "start",
  "submit",
  "complete",
  "rework",
  "release",
  "pause",
  "resume",
  "halt",
] as const;

export type QueueAction = (typeof QUEUE_ACTIONS)[number];

/** Who asks: a person through the operator API, or the scheduler (a shift, an auto-task). */
export const QUEUE_ACTORS = ["operator", "scheduler"] as const;

export type QueueActor = (typeof QUEUE_ACTORS)[number];

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

/** A write to the tracker made through the operator API (`POST /beads…`). */
export const BEAD_WRITES = ["create", "claim", "comment", "close"] as const;

export type BeadWrite = (typeof BEAD_WRITES)[number];

/**
 * Every write `bead.transitioned` records as a tracker write: the bead writes
 * (`POST /beads…`), and `reassign`, the queue's write of a bead's `smith`
 * metadata (`POST /queue/:id/reassign`), which moves no state.
 */
export const TRACKER_WRITES = [...BEAD_WRITES, "reassign"] as const;

export type TrackerWrite = (typeof TRACKER_WRITES)[number];

/**
 * What `bead.transitioned` records for a tracker write. It moves no queue
 * state: `from`, `to` and `reason` are never present, and the validator
 * refuses a payload that mixes this form with a queue transition.
 */
export interface BeadWriteRecord {
  action: TrackerWrite;
  /**
   * SHA-256 (hex) of the one text the write carried: the title of a create,
   * the comment, the close reason. Never the text itself.
   */
  hash?: string;
  /** The length of that text. */
  length?: number;
  /**
   * A reassign's smith: the name `bd` confirmed on the bead. Only on a
   * reassign, and absent from one recorded before the event named it.
   */
  smith?: string;
  from?: never;
  to?: never;
  reason?: never;
}

/** Which surface an `operator.action` came through. */
export const OPERATOR_SURFACES = ["ui", "cli", "mcp", "api"] as const;

export type OperatorSurface = (typeof OPERATOR_SURFACES)[number];

/**
 * Why a shift ended: its time ran out (`elapsed`), an operator stopped it,
 * the host stayed too busy (`throttle`), it could not go on (`halted`), it had
 * nothing left to run (`drained`), it admitted its last bead (`count`), or it
 * spent its budget (`budget`). `recovered`: its process ended without
 * stopping it (Ctrl-C, a crash, a kill), and `forge:shift recover` gave its
 * beads and reservations back and closed it; the shift itself never records
 * this one.
 */
export const SHIFT_STOP_REASONS = [
  "elapsed",
  "operator",
  "throttle",
  "halted",
  "drained",
  "count",
  "budget",
  "recovered",
] as const;

export type ShiftStopReason = (typeof SHIFT_STOP_REASONS)[number];

/** Verdict an evaluator or the council returned for a run. */
export type VerdictOutcome = "pass" | "fail" | "unreadable";

/**
 * The token counts a provider CLI reports for a headless run, each the
 * provider's own field in camelCase: Claude's `result` line (`input_tokens`,
 * `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`)
 * and Codex's `turn.completed` (`input_tokens`, `output_tokens`,
 * `cached_input_tokens`, `cache_write_input_tokens`,
 * `reasoning_output_tokens`). Each provider defines its own counts, so they
 * are compared per provider, not added across providers.
 */
export const PROVIDER_USAGE_COUNTS = [
  "inputTokens",
  "outputTokens",
  "cachedInputTokens",
  "cacheWriteInputTokens",
  "reasoningOutputTokens",
  "cacheReadInputTokens",
  "cacheCreationInputTokens",
] as const;

export type ProviderUsageCount = (typeof PROVIDER_USAGE_COUNTS)[number];

/** What a provider reported a headless run used: token counts, and Claude's `total_cost_usd` as `costUsd`. */
export type ProviderUsage = { [K in ProviderUsageCount]?: number } & {
  costUsd?: number;
};

/** Payload per event kind. Metadata only: hashes, sizes, names, durations. */
export interface LedgerPayloads {
  "session.started": {
    source?: string;
    kind?: SessionKind;
    worktree?: string;
    parentSessionId?: string;
  };
  "session.ended": {
    reason?: string;
    durationMs?: number;
    /** A headless session's usage, when its provider reported any. */
    usage?: ProviderUsage;
  };
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
  /**
   * A queue transition (`from`, `to`), or a tracker write (`action`): one
   * made through the operator API, or a reassign. A write has no `to`: read
   * it only on a payload without `action`.
   */
  "bead.transitioned":
    | {
        from: QueueState | null;
        to: QueueState;
        reason?: string;
      }
    | BeadWriteRecord;
  "reservation.acquired": { worktree: string; globs: string[] };
  "reservation.released": { worktree: string; globs: string[] };
  "shift.started": {
    shiftId: string;
    concurrency: number;
    durationMs?: number;
    filter?: string;
    /** The most beads the shift admits. */
    maxBeads?: number;
    /** The spend, in US dollars, past which it admits no more. */
    maxUsd?: number;
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
    /**
     * The run's findings counted by severity, numbers only (the shape
     * `review.recorded` uses; each count a whole number from 0 to 1,000,000,
     * which the ledger's validator enforces). Present for a completed run, with explicit
     * zeros when it found nothing; absent for a failed or cancelled run, one
     * that produced no run, and any row written before this field existed.
     */
    findings?: ReviewFindings;
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
// stream sends. Added with the API. The types above this line are as they were
// before it, with one later exception: `bead.transitioned` gained a second
// payload form (`BeadWriteRecord`) with the Beads write path, whose `action`
// later also took `reassign` (`TRACKER_WRITES`), and a reassign later an
// optional `smith`.

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
  /**
   * Whether the queue wrote this label: the bead's `queue_state` metadata
   * names the same state. False for a label inherited from a parent or added
   * by hand, which no move but `propose` accepts.
   */
  backed?: boolean;
  /** The smith recorded on the bead (`reassign` writes it as metadata `smith`). */
  smith?: string;
  /**
   * For a paused bead, where `resume` puts it: the state it was paused from
   * (metadata `queue_resume`), or `queued` when that was `running`. Not the
   * metadata value itself.
   */
  resume?: QueueState;
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
 * Who a scoreboard row counts: an event's executor, by smith, provider and
 * model. Its effort and session are not part of the key.
 */
export interface ScoreboardExecutor {
  provider: Provider;
  model: string;
  /** Absent when the events named no configured smith (an interactive session). */
  smith?: string;
}

/**
 * What the ledger holds for one executor (`GET /scoreboard`,
 * `forge:audit --scoreboard`). Every count is of events the ledger stored. A
 * value the ledger does not record is `null` (unknown), never 0.
 */
export interface ScoreboardRow {
  /** Null for the events that carried no executor. */
  executor: ScoreboardExecutor | null;
  /** Distinct Forge runs (`runId`) among the row's counted events. */
  runs: number;
  /**
   * `session.started` events, and `session.ended` events by the reason the
   * ledger stored: the fixed reasons a `forge:exec` adapter writes
   * (`completed`, `failed: …`, `timeout`, `stopped: …`), and `other` for any
   * other reason or none (an interactive session's end is its host's).
   */
  sessions: {
    started: number;
    ended: number;
    completed: number;
    failed: number;
    timedOut: number;
    stopped: number;
    other: number;
  };
  /** `gate.ran` events. `passRate` is `passed / ran`, null when no gate ran. */
  gates: {
    ran: number;
    passed: number;
    failed: number;
    passRate: number | null;
  };
  /** `verdict.bound` events by outcome. */
  verdicts: { pass: number; fail: number; unreadable: number };
  /** `review.recorded` rounds by verdict, and their findings summed by severity. */
  reviews: {
    rounds: number;
    pass: number;
    fail: number;
    unreadable: number;
    findings: ReviewFindings;
  };
  /**
   * `council.run.started` and `council.run.finished` events. `costUsd` sums
   * the finished runs that reported a cost (`runsWithCost` of them), null when
   * none did. `findings` sums the findings by severity of the finished runs
   * that reported them (`runsWithFindings` of them, a completed run's), null
   * when none did: a failed or cancelled run reports none, and neither does
   * a run recorded before `council.run.finished` carried them.
   */
  council: {
    started: number;
    finished: number;
    pass: number;
    fail: number;
    unreadable: number;
    cancelled: number;
    costUsd: number | null;
    runsWithCost: number;
    findings: ReviewFindings | null;
    runsWithFindings: number;
  };
  /**
   * The `usage` of `session.ended` events (`sessions` of them carried one).
   * `costUsd` sums the sessions that reported a cost (`sessionsWithCost`),
   * null when none did; `tokens` holds only the counts some session reported,
   * each summed under the provider's own name.
   */
  usage: {
    sessions: number;
    costUsd: number | null;
    sessionsWithCost: number;
    tokens: { [K in ProviderUsageCount]?: number };
  };
}

/** The scoreboard: one row per executor, in a fixed order, over the events it read. */
export interface Scoreboard {
  /** Rows with a smith by smith name, then those without by provider and model, then the row of no executor. */
  rows: ScoreboardRow[];
  /** How many events were read: the kinds the scoreboard counts, in scope. */
  events: number;
  /** ISO 8601 times of the oldest and newest event read; null when none was. */
  from: string | null;
  to: string | null;
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

// ── Beads write path ────────────────────────────────────────────────────────

/** One priority a bead can be created with, from the priority rubric. */
export interface BeadPriorityOption {
  /** What the route accepts and the page offers: `P0` … `P4`. */
  value: string;
  tier: "critical" | "high" | "medium" | "low";
  /** The rubric's one line on what the tier is for. */
  meaning: string;
}

/** What `GET /beads/options` answers: what a create may say, and how long each text may be. */
export interface BeadOptions {
  types: string[];
  priorities: BeadPriorityOption[];
  defaultPriority: string;
  /** Longest text accepted, in UTF-16 units. */
  limits: {
    title: number;
    description: number;
    acceptance: number;
    comment: number;
    reason: number;
  };
}

/**
 * What `GET /beads/counts` answers: the dashboard's four Beads cards, counted
 * from the tracker by the rules the snapshot builder applies to a `bd export`
 * (`scripts/beads-dashboard.ts`). `open` counts every issue whose stored
 * status is not `in_progress`, `closed` or `blocked` (a deferred issue is
 * open). `blocked` counts the issues that are not closed and wait on a
 * `blocks` or `requires` dependency that is not closed, whatever their stored
 * status; an issue stored as `blocked` with no such dependency is in no card.
 */
export interface BeadCounts {
  open: number;
  inProgress: number;
  blocked: number;
  closed: number;
}

/** What a write to the tracker (`POST /beads…`) answers once `bd` confirmed it. */
export interface BeadWriteResult {
  /** The bead that was written, as `bd` printed it. */
  id: string;
  action: BeadWrite;
  /** The bead's Beads status after the write. */
  status?: string;
  assignee?: string;
  labels?: string[];
  /** The comment a `comment` added; its text is the one that was sent. */
  comment?: { id: string; author: string; createdAt: string };
  /** When `bd` says the bead last changed, for a claim or a close. */
  updatedAt?: string;
  /** Whether the `bead.transitioned` event was stored. The write happened either way. */
  recorded: boolean;
  recordError?: string;
}

// ── Queue actions ───────────────────────────────────────────────────────────

/** What a queue move (`POST /queue/:id/approve|queue|pause|resume`) answers once `bd` confirmed it. */
export interface QueueMoveResult {
  id: string;
  action: QueueAction;
  /** Null when the bead entered the queue with this move. */
  from: QueueState | null;
  to: QueueState;
  /** Whether the `bead.transitioned` event was stored. The label was written either way. */
  recorded: boolean;
  recordError?: string;
}

/** What `POST /queue/:id/reassign` answers: the bead, its state, and the smith now recorded on it. */
export interface QueueReassignResult {
  id: string;
  state: QueueState;
  smith: string;
  /** Whether the `bead.transitioned` event was stored. The smith was written either way. */
  recorded: boolean;
  recordError?: string;
}
