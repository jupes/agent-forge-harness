/**
 * The approval queue's table of legal moves, and what it says about a bead:
 * pure, with no import that a browser bundle cannot take. `queue.ts` makes the
 * moves; the dashboard's Workbench offers the operator moves this table
 * allows.
 */

import {
  QUEUE_LABEL_PREFIX,
  QUEUE_RESUME_KEY,
  type QueueAction,
  type QueueActor,
  type QueueEntry,
  type QueueState,
} from "../../types/hearth";

// ── The table ───────────────────────────────────────────────────────────────

/** One legal move: who may take a bead from one state to another, and what the move is called. */
export interface QueueRule {
  action: QueueAction;
  /** Null: the bead is not in the queue. */
  from: QueueState | null;
  to: QueueState;
  by: readonly QueueActor[];
}

const OPERATOR: readonly QueueActor[] = ["operator"];
const ANYONE: readonly QueueActor[] = ["operator", "scheduler"];

/** The states a bead can be paused from, and so returned to. */
export const PAUSABLE: readonly QueueState[] = [
  "proposed",
  "approved",
  "queued",
  "running",
  "review",
];

/**
 * The states that can be halted. Not `proposed`: the way out of `halted` is
 * `queue`, and that would take a proposal past its approval.
 */
export const HALTABLE: readonly QueueState[] = [
  "approved",
  "queued",
  "running",
  "review",
];

/**
 * Every legal move. Anything not here is refused.
 *
 * It encodes decision 5 (`docs/plans/command-center/05-decisions.md`): work
 * enters as `proposed`; only an operator's `approve` moves it on; only
 * approved or queued work becomes `running`, and the scheduler starts only
 * what is `queued` (an operator may start approved work by hand). `done` is
 * final. A paused bead returns only to the state it was paused from.
 */
export const QUEUE_TABLE: readonly QueueRule[] = [
  { action: "propose", from: null, to: "proposed", by: ANYONE },
  { action: "approve", from: "proposed", to: "approved", by: OPERATOR },
  { action: "queue", from: "approved", to: "queued", by: OPERATOR },
  { action: "queue", from: "halted", to: "queued", by: OPERATOR },
  { action: "start", from: "approved", to: "running", by: OPERATOR },
  { action: "start", from: "queued", to: "running", by: ANYONE },
  { action: "submit", from: "running", to: "review", by: ANYONE },
  { action: "release", from: "running", to: "queued", by: ANYONE },
  { action: "complete", from: "review", to: "done", by: ANYONE },
  { action: "rework", from: "review", to: "queued", by: ANYONE },
  ...PAUSABLE.map(
    (from): QueueRule => ({
      action: "pause",
      from,
      to: "paused",
      by: OPERATOR,
    }),
  ),
  ...PAUSABLE.map(
    (to): QueueRule => ({ action: "resume", from: "paused", to, by: OPERATOR }),
  ),
  ...HALTABLE.map(
    (from): QueueRule => ({ action: "halt", from, to: "halted", by: ANYONE }),
  ),
];

/** The states `reassign` accepts: the work has not started, or has stopped. */
export const REASSIGNABLE: readonly QueueState[] = [
  "proposed",
  "approved",
  "queued",
  "paused",
  "halted",
];

/** Where a bead stands for the table: its state, and for a paused bead where it returns to. */
export interface QueuePosition {
  state: QueueState | null;
  resume?: QueueState | undefined;
}

/**
 * The moves allowed from a state. A paused bead has one: back to the state it
 * was paused from, and none when that is not known.
 */
export function legalMoves(
  state: QueueState | null,
  resume?: QueueState,
): QueueRule[] {
  return QUEUE_TABLE.filter(
    (rule) =>
      rule.from === state && (rule.action !== "resume" || rule.to === resume),
  );
}

/** The action that takes a bead from one state to another, or null when the pair is illegal. */
export function actionFor(
  from: QueueState | null,
  to: QueueState,
): QueueAction | null {
  return (
    QUEUE_TABLE.find((rule) => rule.from === from && rule.to === to)?.action ??
    null
  );
}

export type Decision =
  | { ok: true; to: QueueState }
  | { ok: false; error: string };

/**
 * Whether `by` may take `action` on a bead that stands at `current`, and
 * where it goes. A refusal is the rest of a sentence that begins with the
 * bead's id: it names the current state and every move allowed from it.
 */
export function decide(
  current: QueuePosition,
  action: QueueAction,
  by: QueueActor,
): Decision {
  const moves = legalMoves(current.state, current.resume);
  const rule = moves.find((move) => move.action === action);
  if (rule?.by.includes(by)) return { ok: true, to: rule.to };

  const where =
    current.state === null
      ? "is not in the queue"
      : `is ${QUEUE_LABEL_PREFIX}${current.state}`;
  const from =
    current.state === null ? "outside the queue" : String(current.state);
  const listed = moves.map(
    (move) =>
      `${move.action}${move.action === "resume" ? ` to ${move.to}` : ""} (${move.by.join(", ")})`,
  );
  const allowed =
    listed.length > 0
      ? listed.join(", ")
      : current.state === "paused"
        ? `nothing, until its ${QUEUE_RESUME_KEY} metadata names the state it was paused from`
        : "nothing, it is final";
  const why = rule
    ? `only ${rule.by.join(" or ")} may "${action}" it`
    : `"${action}" is not a move from there`;
  return { ok: false, error: `${where}: ${why}. From ${from}: ${allowed}.` };
}

// ── What an operator may be offered ────────────────────────────────────────

/** The moves an operator makes through the API (`POST /queue/:id/<move>`). */
export type OperatorMove =
  | "approve"
  | "queue"
  | "pause"
  | "resume"
  | "reassign";

const OPERATOR_ACTIONS: readonly QueueAction[] = [
  "approve",
  "queue",
  "pause",
  "resume",
];

/**
 * The operator moves the table allows from an entry's state, and `reassign`
 * where a smith may still be changed. An entry whose label the queue did not
 * write, or a bead with two queue labels, offers nothing: the hearth would
 * refuse every move. A paused bead offers `resume` only when it knows the
 * state it returns to.
 */
export function operatorMoves(
  entry: Pick<QueueEntry, "state" | "backed" | "resume">,
  options: { twoLabels?: boolean } = {},
): OperatorMove[] {
  if (entry.backed !== true || options.twoLabels === true) return [];
  const moves: OperatorMove[] = [];
  for (const rule of legalMoves(entry.state, entry.resume)) {
    if (!rule.by.includes("operator")) continue;
    const action = OPERATOR_ACTIONS.find((known) => known === rule.action);
    if (action !== undefined && !moves.includes(action as OperatorMove))
      moves.push(action as OperatorMove);
  }
  if (REASSIGNABLE.includes(entry.state)) moves.push("reassign");
  return moves;
}
