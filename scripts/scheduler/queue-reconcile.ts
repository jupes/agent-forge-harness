/**
 * Queue moves the ledger missed: each bead's queue state on Beads, compared
 * with the moves the ledger recorded for it.
 *
 * Beads holds a bead's state and the ledger holds its moves (`queue.ts`). Two
 * things make them part, both documented there: a process that ends between
 * the `bd update` and the append leaves a move with no `bead.transitioned`,
 * and two writers with two lock files that make the same move at once record
 * it twice. Hand edits make them part too. This module finds where they part
 * and reports it. It writes nothing, to Beads or to the ledger: Beads is right
 * by definition, and an event made up now for a move made then would be
 * history nobody recorded.
 *
 * The recorded moves of a bead, oldest first, should form a chain: each move
 * starts where the one before it ended (the first from outside the queue),
 * and the last ends at the state the queue wrote on the bead. Each link that
 * does not hold is reported:
 *
 * - `gap`: the bead was found somewhere the recorded moves did not take it: a
 *   move, or several, that the ledger has no event for. `recorded` is where
 *   the moves left it (null: outside the queue), `found` where it was next
 *   seen (the next move's `from`, or the state on the bead now).
 * - `duplicate`: two moves in a row with the same `from` and `to`. Either the
 *   one move was recorded twice, or a move back between them was not
 *   recorded; the ledger cannot tell which.
 *
 * What the ledger no longer holds cannot be compared: once `forge:audit
 * --compact` has removed a bead's first moves, its oldest remaining move is
 * reported as a gap before it. A reassign's event names no smith, so a
 * reassign the ledger missed is not found here.
 */

import {
  type LedgerEvent,
  QUEUE_LABEL_PREFIX,
  type QueueState,
} from "../../types/hearth";
import { safeMessage } from "../hearth/api";
import type { BdResult, BdRunner } from "../hearth/routes/dev-api";
import {
  BD_QUEUE_TIMEOUT_MS,
  isRecord,
  QUEUE_LIST_ARGS,
} from "../hearth/routes/operator-reads";
import { neverStarted, parsed, refusal } from "../hearth/tracker-write";
import { queryEvents } from "../ledger/query";
import { queueStateOf } from "./queue";
import { withQueueLock } from "./queue-lock";

/** A move, or several, made on the bead with no event for it. */
export interface QueueGap {
  kind: "gap";
  beadId: string;
  /** Where the recorded moves left the bead: the `to` of the move before the gap; null when none was recorded before it. */
  recorded: QueueState | null;
  /**
   * Where the bead was found after the gap: the `from` of the next recorded
   * move, or, after the last one, the state the queue wrote on the bead now.
   * Null for outside the queue, or a label the queue did not write.
   */
  found: QueueState | null;
  /** The ledger id of the recorded move before the gap. */
  afterEvent?: number;
  /** The ledger id of the recorded move after the gap; absent when the gap is after the last one. */
  beforeEvent?: number;
  /**
   * After the last recorded move: the queue labels the bead carries now, as
   * the list printed them; none when it did not print the bead (no queue
   * label that names a state, or no such bead).
   */
  labels?: string[];
}

/** Two recorded moves in a row with the same `from` and `to`. */
export interface QueueDuplicate {
  kind: "duplicate";
  beadId: string;
  from: QueueState | null;
  to: QueueState;
  /** The two events' ledger ids, oldest first. */
  events: [number, number];
}

export type QueueDrift = QueueGap | QueueDuplicate;

export interface QueueReconcile {
  /** How many beads were compared: each one the list printed, and each one with a recorded move. */
  beads: number;
  /** How many recorded moves were read. */
  moves: number;
  /** By bead id, then in the order the ledger holds them. */
  drift: QueueDrift[];
}

/** A bead as `bd list --json` prints it: only its own labels and metadata are read. */
export interface ListedBead {
  id: string;
  labels?: unknown;
  metadata?: unknown;
}

interface Move {
  id: number;
  from: QueueState | null;
  to: QueueState;
}

/** The event when it records a queue move: a `bead.transitioned` for a bead, without `action`. */
function moveOf(event: LedgerEvent): (Move & { beadId: string }) | null {
  if (event.kind !== "bead.transitioned" || event.beadId === undefined)
    return null;
  const payload = event.payload;
  // A tracker write moves no state. The ledger stored either form whole.
  if ("action" in payload) return null;
  return {
    id: event.id,
    beadId: event.beadId,
    from: payload.from,
    to: payload.to,
  };
}

/** Where the bead stands on Beads: the state the queue wrote on it, or null, and its queue labels. */
function standingOf(bead: ListedBead | undefined): {
  state: QueueState | null;
  labels: string[];
} {
  if (bead === undefined) return { state: null, labels: [] };
  const standing = queueStateOf(bead);
  const labels = Array.isArray(bead.labels)
    ? bead.labels
        .filter(
          (label): label is string =>
            typeof label === "string" && label.startsWith(QUEUE_LABEL_PREFIX),
        )
        .sort()
    : [];
  return {
    state: standing.kind === "state" ? standing.state : null,
    labels,
  };
}

/** One bead's drift: its recorded moves walked as a chain, then the last against Beads. */
function driftOf(
  beadId: string,
  moves: readonly Move[],
  bead: ListedBead | undefined,
): QueueDrift[] {
  const drift: QueueDrift[] = [];
  let before: Move | undefined;
  for (const move of moves) {
    const recorded = before?.to ?? null;
    if (move.from !== recorded) {
      drift.push(
        before !== undefined &&
          before.from === move.from &&
          before.to === move.to
          ? {
              kind: "duplicate",
              beadId,
              from: move.from,
              to: move.to,
              events: [before.id, move.id],
            }
          : {
              kind: "gap",
              beadId,
              recorded,
              found: move.from,
              ...(before !== undefined ? { afterEvent: before.id } : {}),
              beforeEvent: move.id,
            },
      );
    }
    before = move;
  }
  const now = standingOf(bead);
  const recorded = before?.to ?? null;
  if (now.state !== recorded)
    drift.push({
      kind: "gap",
      beadId,
      recorded,
      found: now.state,
      ...(before !== undefined ? { afterEvent: before.id } : {}),
      labels: now.labels,
    });
  return drift;
}

/**
 * The drift between what `bd list` printed and the ledger's events. Pure. A
 * bead the list did not print is outside the queue; a bead with no recorded
 * move was never moved by the queue.
 */
export function queueDrift(
  beads: readonly ListedBead[],
  events: readonly LedgerEvent[],
): QueueReconcile {
  const listed = new Map(beads.map((bead) => [bead.id, bead]));
  const moves = new Map<string, Move[]>();
  let count = 0;
  for (const event of [...events].sort((a, b) => a.id - b.id)) {
    const move = moveOf(event);
    if (move === null) continue;
    count++;
    const { beadId, ...rest } = move;
    const list = moves.get(beadId) ?? [];
    list.push(rest);
    moves.set(beadId, list);
  }
  const ids = [...new Set([...listed.keys(), ...moves.keys()])].sort();
  return {
    beads: ids.length,
    moves: count,
    drift: ids.flatMap((id) =>
      driftOf(id, moves.get(id) ?? [], listed.get(id)),
    ),
  };
}

export interface ReconcileDeps {
  /** The workspace the queue records its moves under. */
  workspace: string;
  /** Runs `bd` in the checkout that holds the tracker. */
  runBd: BdRunner;
  ledgerPath: string;
  /** The queue lock's file: the one the queue's moves take. */
  lockFile: string;
  /** How long to wait for the lock; the lock's own default otherwise. */
  lockWaitMs?: number | undefined;
  /** How long the list may take; `BD_QUEUE_TIMEOUT_MS` otherwise. */
  bdTimeoutMs?: number | undefined;
}

export type ReconcileRead =
  | { ok: true; value: QueueReconcile }
  | { ok: false; error: string };

const fail = (error: string): ReconcileRead => ({
  ok: false,
  error: safeMessage(error),
});

/** The beads `GET /queue`'s list prints, or why they could not be read. */
async function listed(
  deps: ReconcileDeps,
): Promise<{ ok: true; beads: ListedBead[] } | { ok: false; error: string }> {
  let result: BdResult;
  try {
    result = await deps.runBd([...QUEUE_LIST_ARGS], {
      timeoutMs: deps.bdTimeoutMs ?? BD_QUEUE_TIMEOUT_MS,
    });
  } catch {
    // The runner's own message repeats its arguments; it is not passed on.
    return { ok: false, error: "bd list could not be run." };
  }
  if (result.status === null)
    return {
      ok: false,
      error: neverStarted(result)
        ? "bd could not be started (is it installed, and on the PATH of this process?)."
        : "bd list did not finish: it was stopped before it answered, or it never started.",
    };
  if (result.status !== 0)
    return { ok: false, error: `bd list failed: ${refusal(result)}` };
  const rows = parsed(result.stdout);
  if (rows === undefined)
    return { ok: false, error: "bd list did not print JSON" };
  if (!Array.isArray(rows))
    return { ok: false, error: "bd list did not print a list of issues" };
  const beads: ListedBead[] = [];
  for (const row of rows) {
    const id = isRecord(row) ? row["id"] : undefined;
    if (!isRecord(row) || typeof id !== "string")
      return {
        ok: false,
        error: "bd list printed something that is not an issue",
      };
    beads.push({ id, labels: row["labels"], metadata: row["metadata"] });
  }
  return { ok: true, beads };
}

/**
 * Read the queue from Beads with the list `GET /queue` makes and the
 * workspace's `bead.transitioned` events from the ledger, both under the
 * queue lock, and compare them. Under the lock, a move by a process that
 * shares the lock file is either wholly before the read or wholly after it,
 * so a gap is not a move still being made. Nothing is written.
 */
export async function reconcileQueue(
  deps: ReconcileDeps,
): Promise<ReconcileRead> {
  const held = await withQueueLock(
    deps.lockFile,
    async (): Promise<ReconcileRead> => {
      const read = await listed(deps);
      if (!read.ok) return fail(read.error);
      let events: LedgerEvent[];
      try {
        events = queryEvents(
          { workspace: deps.workspace, kinds: ["bead.transitioned"] },
          { path: deps.ledgerPath },
        );
      } catch (error) {
        return fail(`the ledger could not be read: ${safeMessage(error)}`);
      }
      return { ok: true, value: queueDrift(read.beads, events) };
    },
    deps.lockWaitMs !== undefined ? { waitMs: deps.lockWaitMs } : {},
  );
  return held.ok ? held.value : fail(held.error);
}
