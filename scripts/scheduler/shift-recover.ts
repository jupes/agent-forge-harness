/**
 * Recovering a shift whose process ended without stopping it (Ctrl-C, a
 * crash, a kill): `forge:shift recover <id>` and `POST /shifts/:id/recover`
 * both call `recoverShift`.
 *
 * Such a shift's runs were killed with it (the supervisor's exit hook, and the
 * tree guard for a hard kill), but nothing let its beads go: they stay
 * `queue:running`, their reservations stay held, its record says `running` and
 * no `shift.stopped` was written. Recovery does what the shift's own stop
 * would have done, and no more:
 *
 * - Each bead the shift may still hold (one its record lists as `running`, or
 *   one its runs moved by the ledger that the record does not list, or lists
 *   as `set-aside`) is moved `release` (back to `queued`) as the scheduler,
 *   through `createQueue(...).move`, but only while this shift owns it: its
 *   newest recorded queue move (a `bead.transitioned` with `to`) is a move
 *   into `running` that carries this shift's run id for it. Every `start`
 *   appends its event under the queue lock, and the ownership is read again
 *   inside that lock just before the write, so a bead another shift started
 *   meanwhile (paused, resumed and picked up again) is not released; a start
 *   whose event the ledger did not store is not seen. A bead the record lists
 *   and the shift does not own is left as it is and reported. A released bead
 *   gets one `worklog:` comment.
 * - Every reservation still held in one of its worktrees
 *   (`<main>/trees/<shift-id>-<n>`) is released, whichever bead holds it.
 * - Once nothing is left undone, `shift.stopped` (reason `recovered`) is
 *   appended unless the ledger holds one for the shift already, and the record
 *   is closed. Until then the record stays `running`, so recovering again
 *   finishes the job; what was done is saved on the record as it goes, so a
 *   second recovery never releases a bead or posts a comment twice.
 *
 * Refused before anything is written: an id that is not a shift's, no record
 * of this workspace, a record that has stopped, and a record whose process is
 * alive. A process id the operating system gave to another program after the
 * shift ended reads as alive too: such a shift cannot be recovered until that
 * process ends, and the refusal says so rather than guessing.
 *
 * Two recoveries never run at once: each holds an exclusive lock on
 * `<home>/shifts/recover-lock.db` (the queue lock's mechanism on a file of its
 * own, which the operating system drops with its holder, so no marker is ever
 * left stale) and reads the record again once it has it.
 */

import { join } from "node:path";
import type {
  LedgerEvent,
  LedgerEventInput,
  LedgerEventOf,
  Reservation,
} from "../../types/hearth";
import { comparableCheckout } from "../forge/runs";
import type { BdResult, BdRunner } from "../hearth/routes/dev-api";
import { parsed, refusal, storeEvent } from "../hearth/tracker-write";
import { type AppendResult, appendEvent } from "../ledger/append";
import { activeReservations, queryEvents } from "../ledger/query";
import { createQueue } from "./queue";
import { withQueueLock } from "./queue-lock";
import { release } from "./reservations";
import {
  isShiftId,
  processAlive,
  readShiftRecord,
  type ShiftBeadRecord,
  type ShiftRecord,
  writeShiftRecord,
} from "./shift-store";
import { comparablePath } from "./worktrees";

/** The recovery lock's file, in the shifts directory. Never removed: a waiter may hold it open. */
export const RECOVER_LOCK_FILE = "recover-lock.db";

/** How long a recovery waits for another to finish before it answers busy. */
const RECOVER_WAIT_MS = 5000;

export interface RecoverDeps {
  /** The caller's workspace (the main checkout, as `resolveCheckout` names it): another's shift is not found. */
  workspace: string;
  /** Runs `bd` in the checkout that holds the tracker. */
  runBd: BdRunner;
  ledgerPath: string;
  /** The queue lock: the one the shifts and the operator's moves take. */
  lockFile: string;
  /** `<home>/shifts`: the records, and the recovery lock. */
  shiftsDir: string;
  /** The main checkout: the shift's worktrees are `<mainCheckout>/trees/<shift-id>-<n>`. */
  mainCheckout: string;
  appendEvent?: ((event: LedgerEventInput) => AppendResult) | undefined;
  now?: (() => Date) | undefined;
  /** How long to wait for a recovery in progress; 5 s by default. */
  waitMs?: number | undefined;
}

/**
 * What happened to one bead the shift may have held:
 * - `released`: it was this shift's, and is back in `queued` now;
 * - `left`: it is not this shift's to release (`why` says where it is or who
 *   moved it), and was left as it is;
 * - `pending`: it could not be settled now (`why`); recover again.
 */
export interface RecoveredBead {
  beadId: string;
  runId: string;
  outcome: "released" | "left" | "pending";
  why: string;
  /** The `worklog:` comment bd did not take (it stops nothing). */
  commentError?: string;
}

/** A reservation held in one of the shift's worktrees: freed now, gone already, or still held. */
export interface RecoveredReservation {
  beadId: string;
  worktree: string;
  outcome: "released" | "gone" | "pending";
  error?: string;
}

export interface Recovery {
  shiftId: string;
  /** True once the record is closed and the ledger holds the shift's `shift.stopped`. */
  complete: boolean;
  beads: RecoveredBead[];
  reservations: RecoveredReservation[];
  /** `shift.stopped`: appended by this recovery, found already in the ledger, or not yet. */
  stopped: "recorded" | "found" | "pending";
  /** What is left undone, in words; empty when complete. */
  unfinished: string[];
  record: ShiftRecord;
}

export type RecoverFailure =
  | "invalid"
  | "not-found"
  | "stopped"
  | "alive"
  | "busy"
  | "failed";

export type RecoverOutcome =
  | { ok: true; value: Recovery }
  | { ok: false; kind: RecoverFailure; error: string };

const no = (kind: RecoverFailure, error: string): RecoverOutcome => ({
  ok: false,
  kind,
  error,
});

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** The `worklog:` comment a bead gets when a recovery puts it back in `queued`. */
export function recoveredComment(input: {
  shiftId: string;
  pid: number;
  runId: string;
  attempts: number;
}): string {
  const runs = `${input.attempts} run${input.attempts === 1 ? "" : "s"}`;
  return `worklog: shift ${input.shiftId} was recovered after its process (pid ${input.pid}) ended while this bead was running (${runs}, run ${input.runId}): the bead is back in queued. Its events: bun run forge:audit --run ${input.runId}.`;
}

/** The record when the shift may be recovered, else the refusal. Reads only. */
function recoverable(
  id: string,
  deps: RecoverDeps,
): { ok: true; record: ShiftRecord } | { ok: false; refused: RecoverOutcome } {
  if (!isShiftId(id))
    return {
      ok: false,
      refused: no(
        "invalid",
        "id: expected a shift id (shift-YYYYMMDD-HHMMSS-xxxx)",
      ),
    };
  const record = readShiftRecord(deps.shiftsDir, id);
  if (
    record === null ||
    comparableCheckout(record.workspace) !== comparableCheckout(deps.workspace)
  )
    return {
      ok: false,
      refused: no("not-found", `No shift of this workspace has the id ${id}.`),
    };
  if (record.state === "stopped")
    return {
      ok: false,
      refused: no(
        "stopped",
        `${id} has stopped already (${record.reason ?? "no reason recorded"}); there is nothing to recover.`,
      ),
    };
  if (processAlive(record.pid))
    return {
      ok: false,
      refused: no(
        "alive",
        `${id}'s process (pid ${record.pid}) is running, so the shift is not recovered: stop it with bun run forge:shift stop ${id}. If that process is not the shift (the operating system gave its pid to another program after the shift ended), it cannot be told apart here: recover the shift once that process has ended. Nothing was done.`,
      ),
    };
  return { ok: true, record };
}

/**
 * Recover the shift `id`: give back the beads it still holds and the
 * reservations of its worktrees, then close its record and record
 * `shift.stopped` (reason `recovered`). See the file's comment for the rules.
 * A refusal writes nothing. An answer with `complete: false` lists what is
 * left; the record stays `running` and recovering again finishes it.
 */
export async function recoverShift(
  id: string,
  deps: RecoverDeps,
): Promise<RecoverOutcome> {
  const first = recoverable(id, deps);
  if (!first.ok) return first.refused;
  const held = await withQueueLock(
    join(deps.shiftsDir, RECOVER_LOCK_FILE),
    () => recoverLocked(id, deps),
    { waitMs: deps.waitMs ?? RECOVER_WAIT_MS },
  );
  if (held.ok) return held.value;
  return held.reason === "busy"
    ? no(
        "busy",
        `another recovery is in progress; this one did nothing. Run it again once that one has finished.`,
      )
    : no("failed", "the recovery lock could not be taken; nothing was done.");
}

/** Ownership of a bead, as the ledger says it: `final` is false when the ledger could not be read. */
type Ownership =
  | { owned: true }
  | { owned: false; final: boolean; why: string };

type Move = LedgerEventOf<"bead.transitioned"> & {
  payload: { from: string | null; to: string; reason?: string };
};

function isMove(event: LedgerEvent): event is Move {
  return (
    event.kind === "bead.transitioned" &&
    !("action" in event.payload) &&
    typeof event.payload.to === "string"
  );
}

async function recoverLocked(
  id: string,
  deps: RecoverDeps,
): Promise<RecoverOutcome> {
  // Read again under the lock: a recovery that held it first may have finished.
  const checked = recoverable(id, deps);
  if (!checked.ok) return checked.refused;
  let record = checked.record;
  const { workspace } = record;
  const ledger = { path: deps.ledgerPath };
  const now = deps.now ?? (() => new Date());
  const append =
    deps.appendEvent ??
    ((event: LedgerEventInput) => appendEvent(event, ledger));
  /** Every event of a bead's story carries its run id, as the shift's own do. */
  const appendFor =
    (runId: string | undefined) =>
    (event: LedgerEventInput): AppendResult =>
      append(runId === undefined ? event : { ...event, runId });
  const unfinished: string[] = [];
  const save = (what: ShiftRecord): boolean => {
    try {
      writeShiftRecord(deps.shiftsDir, what);
      return true;
    } catch (error) {
      unfinished.push(`the record could not be written: ${message(error)}`);
      return false;
    }
  };

  // The beads this shift's runs moved, from the ledger alone (as `forge:audit
  // --shift` finds them): a bead it claimed and then died before saving in its
  // record is found here.
  let shiftMoves: LedgerEvent[];
  try {
    shiftMoves = queryEvents(
      { workspace, shiftId: id, kinds: ["bead.transitioned"] },
      ledger,
    );
  } catch (error) {
    return no(
      "failed",
      `the ledger could not be read (${message(error)}); nothing was done.`,
    );
  }

  /** Who moved the bead last, and whether that was this run's start. */
  function ownership(beadId: string, runId: string): Ownership {
    let newest: Move | undefined;
    try {
      newest = queryEvents(
        { workspace, beadId, beadExact: true, kinds: ["bead.transitioned"] },
        ledger,
      )
        .filter(isMove)
        .at(-1);
    } catch (error) {
      return {
        owned: false,
        final: false,
        why: `the ledger could not be read to tell whose it is (${message(error)})`,
      };
    }
    if (newest === undefined)
      return {
        owned: false,
        final: true,
        why: "the ledger holds no queue move of it, so it is not known to be this shift's; left as it is",
      };
    if (newest.runId === runId && newest.payload.to === "running")
      return { owned: true };
    const move = `${newest.payload.from ?? "outside the queue"} to ${newest.payload.to} (${newest.payload.reason ?? "no reason recorded"}${newest.runId !== undefined ? `, run ${newest.runId}` : ""})`;
    return {
      owned: false,
      final: true,
      // Its own run id on a move that is not a start: the shift moved it on
      // before its process ended, or a recovery did before it could write
      // the record.
      why:
        newest.runId === runId
          ? `its newest recorded move is this shift's own and not its start: ${move}; left as it is`
          : `it was moved after this shift started it: ${move}; left as it is`,
    };
  }

  interface Candidate {
    beadId: string;
    runId: string;
    /** Whether the record lists it as running: one it does not is reported only when it is released. */
    listed: boolean;
  }
  const candidates: Candidate[] = record.beads
    .filter((entry) => entry.outcome === "running")
    .map((entry) => ({
      beadId: entry.beadId,
      runId: entry.runId,
      listed: true,
    }));
  for (const event of shiftMoves) {
    const { beadId, runId } = event;
    if (beadId === undefined || runId === undefined) continue;
    if (candidates.some((candidate) => candidate.beadId === beadId)) continue;
    const entry = record.beads.find((each) => each.beadId === beadId);
    // An entry the shift settled (review, released, halted, left) is its own word.
    if (entry !== undefined && entry.outcome !== "set-aside") continue;
    candidates.push({ beadId, runId, listed: false });
  }

  /** The bead's record entry, made when the record did not have it. */
  const entryOf = (candidate: Candidate): ShiftBeadRecord => {
    const found = record.beads.find((each) => each.beadId === candidate.beadId);
    if (found !== undefined) return found;
    const made: ShiftBeadRecord = {
      beadId: candidate.beadId,
      runId: candidate.runId,
      outcome: "set-aside",
      attempts: 0,
    };
    record.beads.push(made);
    return made;
  };
  const settle = (
    candidate: Candidate,
    outcome: "released" | "left",
    why: string,
  ): ShiftBeadRecord => {
    const entry = entryOf(candidate);
    entry.outcome = outcome;
    const said = `recovered: ${why}`;
    entry.error = entry.error === undefined ? said : `${entry.error}; ${said}`;
    return entry;
  };

  const beads: RecoveredBead[] = [];
  for (const candidate of candidates) {
    const { beadId, runId } = candidate;
    const before = ownership(beadId, runId);
    if (!before.owned) {
      if (!candidate.listed) continue;
      if (!before.final) {
        beads.push({ beadId, runId, outcome: "pending", why: before.why });
        unfinished.push(`${beadId}: ${before.why}`);
        continue;
      }
      settle(candidate, "left", before.why);
      save(record);
      beads.push({ beadId, runId, outcome: "left", why: before.why });
      continue;
    }

    // The ownership is read again inside the queue lock, just before the
    // write: a start by another shift takes that lock and records its event
    // inside it, so it is either seen here or made after this release. A
    // bead it no longer owns gets no write: the update is answered as
    // refused, which the move reports as "nothing was changed".
    const guard: { veto: Ownership | null } = { veto: null };
    const guarded: BdRunner = async (args, options) => {
      if (args[0] === "update" && args.at(-1) === beadId) {
        const current = ownership(beadId, runId);
        if (!current.owned) {
          guard.veto = current;
          return { status: 1, stdout: "", stderr: `Error: ${current.why}\n` };
        }
      }
      return deps.runBd(args, options);
    };
    const moved = await createQueue({
      workspace,
      runBd: guarded,
      appendEvent: appendFor(runId),
      lockFile: deps.lockFile,
    }).move(beadId, "release", "scheduler");

    if (moved.ok) {
      const why = `its process had ended while it ran; it was put back in queued${moved.value.recorded ? "" : ` (the move's event was not recorded: ${moved.value.recordError ?? "no reason"})`}`;
      const entry = settle(candidate, "released", why);
      const done: RecoveredBead = { beadId, runId, outcome: "released", why };
      const failure = await postComment(
        deps.runBd,
        beadId,
        recoveredComment({
          shiftId: id,
          pid: record.pid,
          runId,
          attempts: entry.attempts,
        }),
      );
      if (failure !== null) {
        const said = `recovered comment: ${failure}`;
        entry.commentError =
          entry.commentError === undefined
            ? said
            : `${entry.commentError}; ${said}`;
        done.commentError = failure;
      }
      save(record);
      beads.push(done);
      continue;
    }
    const { veto } = guard;
    // Refused by the table (it is not running), gone, or left with two
    // labels: nothing a second try changes. Busy, a bd failure, an unknown
    // write: try again.
    const why =
      veto !== null && !veto.owned ? veto.why : `release: ${moved.error}`;
    const final =
      veto !== null && !veto.owned
        ? veto.final
        : moved.kind === "refused" ||
          moved.kind === "not-found" ||
          moved.kind === "conflict";
    if (!final) {
      beads.push({ beadId, runId, outcome: "pending", why });
      unfinished.push(`${beadId}: ${why}`);
      continue;
    }
    settle(candidate, "left", why);
    save(record);
    beads.push({ beadId, runId, outcome: "left", why });
  }

  // Every reservation still held in one of its worktrees, whichever bead holds it.
  const reservations: RecoveredReservation[] = [];
  let held: Reservation[] = [];
  try {
    held = activeReservations({ workspace }, ledger);
  } catch (error) {
    unfinished.push(`the reservations could not be read: ${message(error)}`);
  }
  const trees = `${comparablePath(join(deps.mainCheckout, "trees"))}/`;
  const ownTree = (worktree: string): boolean => {
    const path = comparablePath(worktree);
    if (!path.startsWith(trees)) return false;
    const name = path.slice(trees.length);
    return (
      name.startsWith(`${id}-`) && /^[0-9]+$/.test(name.slice(id.length + 1))
    );
  };
  for (const reservation of held) {
    if (!ownTree(reservation.worktree)) continue;
    const runId =
      record.beads.find((each) => each.beadId === reservation.beadId)?.runId ??
      candidates.find((each) => each.beadId === reservation.beadId)?.runId;
    const freed = await release(
      { beadId: reservation.beadId, worktree: reservation.worktree },
      {
        workspace,
        ledgerPath: deps.ledgerPath,
        appendEvent: appendFor(runId),
        lockFile: deps.lockFile,
      },
    ).catch((error: unknown) => ({
      ok: false as const,
      kind: "failed" as const,
      error: message(error),
    }));
    const where = {
      beadId: reservation.beadId,
      worktree: reservation.worktree,
    };
    if (freed.ok) reservations.push({ ...where, outcome: "released" });
    else if (freed.kind === "not-held")
      reservations.push({ ...where, outcome: "gone" });
    else {
      reservations.push({ ...where, outcome: "pending", error: freed.error });
      unfinished.push(
        `the reservation of ${reservation.beadId} in ${reservation.worktree}: ${freed.error}`,
      );
    }
  }

  // Close it only once nothing is left: until then it stays running, and
  // recovering again picks up from here.
  let stopped: Recovery["stopped"] = "pending";
  if (unfinished.length === 0) {
    let found = false;
    try {
      found =
        queryEvents(
          { workspace, shiftId: id, kinds: ["shift.stopped"] },
          ledger,
        ).length > 0;
    } catch (error) {
      unfinished.push(`the ledger could not be read: ${message(error)}`);
    }
    if (unfinished.length === 0 && found) stopped = "found";
    else if (unfinished.length === 0) {
      const unrecorded = await storeEvent(append, {
        kind: "shift.stopped",
        workspace,
        payload: { shiftId: id, reason: "recovered" },
      });
      if (unrecorded === null) stopped = "recorded";
      else unfinished.push(`shift.stopped was not recorded: ${unrecorded}`);
    }
  }
  if (unfinished.length === 0) {
    const said = `its process (pid ${record.pid}) ended without stopping the shift; it was recovered`;
    const closed: ShiftRecord = {
      ...record,
      state: "stopped",
      reason: "recovered",
      endedAt: now().toISOString(),
      error: record.error === undefined ? said : `${record.error}; ${said}`,
    };
    if (save(closed)) record = closed;
  }

  return {
    ok: true,
    value: {
      shiftId: id,
      complete: unfinished.length === 0,
      beads,
      reservations,
      stopped,
      unfinished,
      record,
    },
  };
}

/** What is left of a recovery that did not finish, as one sentence for an error line. */
export function unfinishedMessage(recovery: Recovery): string {
  return `${recovery.shiftId} is not recovered yet: ${recovery.unfinished.join("; ")}. Its record stays running: recover it again to finish.`;
}

/**
 * One `bd comments add`, made and confirmed as the shift makes its own
 * (`shift.ts`, whose copy is not imported: it brings the executors into the
 * hearth): both values after the `--`, never repeated. Null once bd printed
 * the comment on that issue, else why not, in words that never repeat the
 * text.
 */
async function postComment(
  runBd: BdRunner,
  beadId: string,
  text: string,
): Promise<string | null> {
  let result: BdResult;
  try {
    result = await runBd(["comments", "add", "--json", "--", beadId, text]);
  } catch {
    return "bd comments add could not be run";
  }
  if (result.status === null)
    return "bd comments add did not finish, or never started; the comment may have been added";
  if (result.status !== 0) return `bd comments add failed: ${refusal(result)}`;
  const printed = parsed(result.stdout);
  return typeof printed === "object" &&
    printed !== null &&
    (printed as Record<string, unknown>)["issue_id"] === beadId
    ? null
    : "bd comments add exited 0 but printed no comment on the bead";
}
