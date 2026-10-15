/**
 * What the Workbench shows, from what the hearth answered: the approval queue
 * as columns of queue states, a card per (bead, queue label), each with the
 * operator moves the queue's table allows and, for a queued bead, whether it
 * may start now and why not.
 *
 * Pure: answers in, columns out. The moves come from the same table the
 * hearth enforces (`scripts/scheduler/queue-table.ts`), so the page never
 * offers a move the hearth would refuse.
 */

import type { Eligibility } from "../../scripts/scheduler/eligibility";
import {
  type OperatorMove,
  operatorMoves,
  resumeTarget,
} from "../../scripts/scheduler/queue-table";
import {
  QUEUE_STATES,
  type QueueEntry,
  type QueueState,
} from "../../types/hearth";
import { NotSent } from "./operator";

/** The columns, left to right: the happy path, then the two side states, then the end. */
export const COLUMN_ORDER = [
  "proposed",
  "approved",
  "queued",
  "running",
  "review",
  "paused",
  "halted",
  "done",
] as const satisfies readonly QueueState[];

export const COLUMN_LABELS: Record<QueueState, string> = {
  proposed: "Proposed",
  approved: "Approved",
  queued: "Queued",
  running: "Running",
  review: "Review",
  paused: "Paused",
  halted: "Halted",
  done: "Done",
};

/** How many Done cards are shown; the rest are counted. */
export const DONE_SHOWN = 20;

export interface WorkbenchCard {
  id: string;
  title: string;
  state: QueueState;
  status: string;
  moves: OperatorMove[];
  /** The smith the bead's work goes to: its own, else the default (null when unknown). */
  smith: string | null;
  smithIsDefault: boolean;
  /** Why the card offers nothing, or only propose, when there is a reason. */
  note?: string;
  /** For a paused bead that can be resumed: where Resume puts it, and that said in words. */
  resumes?: { to: QueueState; says: string };
  /** For a queued bead, when eligibility was read: may it start now, and if not why. */
  start?: { may: true } | { may: false; why: string; waitsOn?: string };
}

export interface WorkbenchColumn {
  state: QueueState;
  label: string;
  cards: WorkbenchCard[];
  /** Cards not shown (Done only). */
  hidden: number;
}

const natural = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

/**
 * Where Resume puts a paused bead, in words: back where it was paused from,
 * or Queued for a bead paused while running (`resumeTarget`), since nothing
 * runs it after a pause and a shift starts it from there.
 */
function resumeSays(to: QueueState): string {
  return to === "queued"
    ? "Resume puts it in Queued, where a shift starts it. A bead paused while it was running goes there too: nothing runs it after a pause."
    : `Resume returns it to ${COLUMN_LABELS[to]}.`;
}

export function workbenchColumns(
  queue: readonly QueueEntry[],
  eligibility: Eligibility | null,
  defaultSmith: string | null,
): WorkbenchColumn[] {
  const labelsOf = new Map<string, number>();
  for (const entry of queue)
    labelsOf.set(entry.beadId, (labelsOf.get(entry.beadId) ?? 0) + 1);
  const waiting = new Map(
    (eligibility?.waiting ?? []).map((wait) => [wait.id, wait]),
  );
  const eligible = new Set(
    (eligibility?.eligible ?? []).map((bead) => bead.id),
  );

  const card = (entry: QueueEntry): WorkbenchCard => {
    const twoLabels = (labelsOf.get(entry.beadId) ?? 0) > 1;
    const note = twoLabels
      ? "Carries two queue labels: no move is made until one is taken out by hand."
      : entry.backed !== true
        ? "The queue did not write this label (inherited from a parent, or added by hand), so the bead is in no queue state: Propose puts it in the queue as proposed, where it waits for an approval."
        : entry.state === "paused" && entry.resume === undefined
          ? "Its queue_resume metadata names no state it can return to, so it cannot be resumed: set it by hand (bd update <id> --set-metadata=queue_resume=<state>)."
          : undefined;
    const moves = operatorMoves(entry, { twoLabels });
    const resumeTo =
      moves.includes("resume") && entry.resume !== undefined
        ? resumeTarget(entry.resume)
        : undefined;
    const wait = waiting.get(entry.beadId);
    const start: WorkbenchCard["start"] =
      entry.state !== "queued" || eligibility === null
        ? undefined
        : eligible.has(entry.beadId)
          ? { may: true }
          : wait !== undefined
            ? {
                may: false,
                why: wait.why,
                ...(wait.waitsOn !== undefined
                  ? { waitsOn: wait.waitsOn }
                  : {}),
              }
            : undefined;
    return {
      id: entry.beadId,
      title: entry.title,
      state: entry.state,
      status: entry.status,
      moves,
      smith: entry.smith ?? defaultSmith,
      smithIsDefault: entry.smith === undefined,
      ...(note !== undefined ? { note } : {}),
      ...(resumeTo !== undefined
        ? { resumes: { to: resumeTo, says: resumeSays(resumeTo) } }
        : {}),
      ...(start !== undefined ? { start } : {}),
    };
  };

  return COLUMN_ORDER.map((state) => {
    const cards = queue
      .filter((entry) => entry.state === state)
      .map(card)
      .sort((a, b) => natural.compare(a.id, b.id));
    const shown = state === "done" ? cards.slice(0, DONE_SHOWN) : cards;
    return {
      state,
      label: COLUMN_LABELS[state],
      cards: shown,
      hidden: cards.length - shown.length,
    };
  });
}

// ── What a move's answer means ──────────────────────────────────────────────

const MOVE_DONE: Record<OperatorMove, string> = {
  propose: "Proposed",
  approve: "Approved",
  queue: "Queued",
  pause: "Paused",
  resume: "Resumed",
  reassign: "Reassigned",
};

/** What the last move on a card came to. */
export interface MoveOutcome {
  tone: "done" | "failed" | "unknown";
  message: string;
}

/**
 * What one move's answer means for the card, by the write path's rules: no
 * answer, a 504, or a success that is not the control plane's envelope means
 * the outcome is not known; a refusal is said in the hearth's own words; only
 * an `ok: true` envelope is done; a resume says where the answer put the bead.
 * A move that could not get an operator token (`NotSent`) was not sent, so it
 * failed and changed nothing.
 */
export async function moveOutcome(
  id: string,
  move: OperatorMove,
  send: () => Promise<Response>,
): Promise<MoveOutcome> {
  const unknown: MoveOutcome = {
    tone: "unknown",
    message: `Outcome not known (${move}). Check with \`bd show ${id}\` before trying again.`,
  };
  let response: Response;
  try {
    response = await send();
  } catch (error) {
    if (error instanceof NotSent)
      return {
        tone: "failed",
        message: `Not sent (${move}): the page could not get an operator token from the control plane (${error.message}). Nothing was changed.`,
      };
    return unknown;
  }
  if (response.status === 504) return unknown;
  let envelope: { ok?: unknown; data?: unknown; error?: unknown } | null = null;
  try {
    envelope = (await response.json()) as {
      ok?: unknown;
      data?: unknown;
      error?: unknown;
    };
  } catch {
    envelope = null;
  }
  if (response.ok) {
    if (envelope?.ok !== true) return unknown;
    const data = envelope.data;
    const to =
      move === "resume" && typeof data === "object" && data !== null
        ? QUEUE_STATES.find((state) => state === (data as { to?: unknown }).to)
        : undefined;
    return {
      tone: "done",
      message: `${MOVE_DONE[move]} ${id}${to !== undefined ? ` to ${COLUMN_LABELS[to]}` : ""}.`,
    };
  }
  return {
    tone: "failed",
    message:
      typeof envelope?.error === "string"
        ? envelope.error
        : `The control plane answered ${response.status}.`,
  };
}
