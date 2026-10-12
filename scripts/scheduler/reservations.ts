/**
 * File reservations: which files a bead's work may touch, whether two such
 * claims can touch the same file, and the claims themselves in the ledger.
 *
 * A bead's claim is the file map of its description (else of its acceptance
 * criteria), in the dialect `filemap.ts` parses: `*` within one path
 * segment, `?` for one character, a segment that is exactly `**` for any
 * number of segments, every other character literal. A map that is missing,
 * empty or malformed claims everything (`**`): a narrower guess is unsafe.
 *
 * Two globs overlap when some path matches both, decided exactly for that
 * dialect and without regard to case (Windows paths ignore it). A glob whose
 * last segment is literal also covers everything under it: `scripts/scheduler`
 * is read as the directory too.
 */

import type { LedgerEventInput, Reservation } from "../../types/hearth";
import { isBeadId } from "../hearth/tracker-write";
import { type AppendResult, appendEvent } from "../ledger/append";
import { activeReservations } from "../ledger/query";
import { parseFileMap } from "./filemap";
import { withQueueLock } from "./queue-lock";
import { comparablePath, isSessionId } from "./worktrees";

// ── Overlap ─────────────────────────────────────────────────────────────────

const WILDCARD = /[*?]/;

/** Longer than this, a glob is not compared: it is taken to overlap everything. */
export const MAX_GLOB_LENGTH = 1024;
/** Longer than this (in characters), a segment is not compared either. */
export const MAX_SEGMENT_LENGTH = 255;

/** Why a glob is too long to compare, or null. */
export function tooLong(glob: string): string | null {
  if (glob.length > MAX_GLOB_LENGTH)
    return `a glob is longer than ${MAX_GLOB_LENGTH} characters`;
  for (const segment of glob.split("/"))
    if ([...segment].length > MAX_SEGMENT_LENGTH)
      return `a glob has a segment longer than ${MAX_SEGMENT_LENGTH} characters`;
  return null;
}

/** One character in the case it is compared in: lowered, unless lowering makes it more than one. */
function folded(character: string): string {
  const lower = character.toLowerCase();
  return [...lower].length === 1 ? lower : character;
}

/**
 * A glob as segments of characters (code points, not UTF-16 units), in NFC,
 * case-folded one character at a time, without `.` segments, and with the
 * covering rule applied. `**` stays a segment of its own.
 */
function segmentsOf(glob: string): string[][] {
  const segments = glob
    .normalize("NFC")
    .split("/")
    .filter((segment) => segment !== "" && segment !== ".");
  const last = segments.at(-1);
  if (last !== undefined && last !== "**" && !WILDCARD.test(last))
    segments.push("**");
  return segments.map((segment) =>
    segment === "**" ? ["**"] : [...segment].map(folded),
  );
}

const isAnySegments = (segment: readonly string[] | undefined): boolean =>
  segment?.length === 1 && segment[0] === "**";

/** Whether some string matches both segment patterns (`*` any run, `?` one character). */
function segmentsMeet(p: readonly string[], q: readonly string[]): boolean {
  const memo = new Map<number, boolean>();
  const meet = (i: number, j: number): boolean => {
    const key = i * (q.length + 1) + j;
    const known = memo.get(key);
    if (known !== undefined) return known;
    let result: boolean;
    if (i === p.length && j === q.length) result = true;
    else if (p[i] === "*")
      result = meet(i + 1, j) || (j < q.length && meet(i, j + 1));
    else if (q[j] === "*")
      result = meet(i, j + 1) || (i < p.length && meet(i + 1, j));
    else if (i === p.length || j === q.length) result = false;
    else if (p[i] === "?" || q[j] === "?" || p[i] === q[j])
      result = meet(i + 1, j + 1);
    else result = false;
    memo.set(key, result);
    return result;
  };
  return meet(0, 0);
}

/**
 * Whether some path matches both globs. A glob too long to compare is taken
 * to overlap everything: the unsafe answer is the other one.
 */
export function globsOverlap(a: string, b: string): boolean {
  if (tooLong(a) !== null || tooLong(b) !== null) return true;
  const as = segmentsOf(a);
  const bs = segmentsOf(b);
  const memo = new Map<number, boolean>();
  const meet = (i: number, j: number): boolean => {
    const key = i * (bs.length + 1) + j;
    const known = memo.get(key);
    if (known !== undefined) return known;
    let result: boolean;
    if (i === as.length && j === bs.length) result = true;
    else if (isAnySegments(as[i]))
      // `**` matches no segment, or one more of the other side's.
      result = meet(i + 1, j) || (j < bs.length && meet(i, j + 1));
    else if (isAnySegments(bs[j]))
      result = meet(i, j + 1) || (i < as.length && meet(i + 1, j));
    else if (i === as.length || j === bs.length) result = false;
    else
      result =
        segmentsMeet(as[i] as string[], bs[j] as string[]) &&
        meet(i + 1, j + 1);
    memo.set(key, result);
    return result;
  };
  return meet(0, 0);
}

/** The first pair of globs that overlap, one from each list, or null. */
export function overlapOf(
  as: readonly string[],
  bs: readonly string[],
): [string, string] | null {
  for (const a of as) for (const b of bs) if (globsOverlap(a, b)) return [a, b];
  return null;
}

export function mapsOverlap(
  as: readonly string[],
  bs: readonly string[],
): boolean {
  return overlapOf(as, bs) !== null;
}

// ── What a bead reserves ────────────────────────────────────────────────────

export interface BeadText {
  id: string;
  description?: string | undefined;
  acceptance_criteria?: string | undefined;
}

export interface BeadReservation {
  globs: string[];
  /** True when the map was missing, empty or malformed and everything is claimed. */
  conservative: boolean;
  /** Why, when conservative. */
  reason?: string;
}

/** Claims everything: what a bead with no usable map reserves. */
export const EVERYTHING = "**";

/**
 * The globs a bead's work may touch: the file map of its description, else
 * of its acceptance criteria. The first text that has a `Files` section is
 * the one read, even when that section is not usable.
 */
export function reservationFor(bead: BeadText): BeadReservation {
  let why =
    "the bead has no `Files` section in its description or acceptance criteria";
  for (const text of [bead.description, bead.acceptance_criteria]) {
    if (typeof text !== "string") continue;
    const map = parseFileMap(text);
    if (map.ok) {
      const long = map.globs.map(tooLong).find((why) => why !== null);
      if (long === undefined) return { globs: map.globs, conservative: false };
      why = long;
      break;
    }
    if (map.reason === "missing") continue;
    why = map.error;
    break;
  }
  return {
    globs: [EVERYTHING],
    conservative: true,
    reason: `${why}; the whole repository is reserved`,
  };
}

// ── Reserving and releasing ─────────────────────────────────────────────────

export interface ReservationDeps {
  /** The workspace the events are recorded under: the main checkout, as `resolveCheckout` names it. */
  workspace: string;
  ledgerPath: string;
  /** The ledger's `appendEvent`; defaults to the one bound to `ledgerPath`. */
  appendEvent?: ((event: LedgerEventInput) => AppendResult) | undefined;
  /** The queue lock's file: the same one queue moves take, so a move and a reservation never interleave. */
  lockFile: string;
  lockWaitMs?: number | undefined;
}

export type ReservationFailure =
  | "invalid"
  | "conflict"
  | "not-held"
  | "busy"
  | "failed";

export type ReservationOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; kind: ReservationFailure; error: string };

const refused = <T>(
  kind: ReservationFailure,
  error: string,
): ReservationOutcome<T> => ({ ok: false, kind, error });

const MAX_GLOBS = 200;

/** Why `globs` is not a reservation's, or null: each one a glob the file-map parser accepts as written. */
function badGlobs(globs: unknown): string | null {
  if (!Array.isArray(globs) || globs.length === 0)
    return "globs: expected at least one glob";
  if (globs.length > MAX_GLOBS) return `globs: at most ${MAX_GLOBS} globs`;
  for (const glob of globs) {
    if (typeof glob !== "string") return "globs: expected strings";
    const long = tooLong(glob);
    if (long !== null) return `globs: ${long}`;
    const map = parseFileMap(`## Files\n${glob}\n`);
    if (!map.ok || map.globs.length !== 1 || map.globs[0] !== glob)
      return `globs: "${glob}" is not a glob of the file-map format (relative, forward slashes, no "..", and a directory written as dir/**)`;
  }
  return null;
}

const sameGlobs = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((glob) => b.includes(glob));

async function locked<T>(
  deps: ReservationDeps,
  work: () => ReservationOutcome<T>,
): Promise<ReservationOutcome<T>> {
  const held = await withQueueLock(
    deps.lockFile,
    async () => work(),
    deps.lockWaitMs !== undefined ? { waitMs: deps.lockWaitMs } : {},
  );
  if (held.ok) return held.value;
  return refused(held.reason === "busy" ? "busy" : "failed", held.error);
}

function append(deps: ReservationDeps, event: LedgerEventInput): string | null {
  const result = (
    deps.appendEvent ??
    ((input: LedgerEventInput) => appendEvent(input, { path: deps.ledgerPath }))
  )(event);
  return result.ok ? null : result.error;
}

/**
 * Reserve `globs` for a bead's work in `worktree`. Under the queue lock, the
 * ledger's active reservations are read, and the reservation is refused when
 * another bead's overlaps it; the same reservation again is already held, and
 * the same bead and worktree with other globs must be released first. The
 * worktree is stored in one spelling (`comparablePath`), so a release in any
 * other finds it. A reservation of a closed bead still counts here: free it
 * with `release` (`readEligibility` reports such reservations as stale).
 */
export async function reserve(
  request: {
    beadId: string;
    worktree: string;
    globs: readonly string[];
    sessionId?: string | undefined;
  },
  deps: ReservationDeps,
): Promise<ReservationOutcome<{ reservation: Reservation; already: boolean }>> {
  if (!isBeadId(request.beadId))
    return refused("invalid", "beadId: expected a Beads issue id");
  if (request.sessionId !== undefined && !isSessionId(request.sessionId))
    return refused("invalid", "sessionId: expected a session id");
  if (typeof request.worktree !== "string" || request.worktree.trim() === "")
    return refused("invalid", "worktree: expected a path");
  const bad = badGlobs(request.globs);
  if (bad !== null) return refused("invalid", bad);
  const worktree = comparablePath(request.worktree);
  const globs = [...request.globs];

  return locked(deps, () => {
    const active = activeReservations(
      { workspace: deps.workspace },
      { path: deps.ledgerPath },
    );
    const mine = active.find(
      (r) =>
        r.beadId === request.beadId && comparablePath(r.worktree) === worktree,
    );
    if (mine !== undefined)
      return sameGlobs(mine.globs, globs)
        ? { ok: true, value: { reservation: mine, already: true } }
        : refused(
            "conflict",
            `${request.beadId} already holds other globs in ${mine.worktree} (${mine.globs.join(", ")}); release them first`,
          );
    for (const other of active) {
      if (other.beadId === request.beadId) continue;
      const pair = overlapOf(globs, other.globs);
      if (pair !== null)
        return refused(
          "conflict",
          `${pair[0]} overlaps ${pair[1]}, reserved by ${other.beadId} in ${other.worktree}; nothing was reserved`,
        );
    }
    const failed = append(deps, {
      kind: "reservation.acquired",
      workspace: deps.workspace,
      beadId: request.beadId,
      ...(request.sessionId !== undefined
        ? { sessionId: request.sessionId }
        : {}),
      payload: { worktree, globs },
    });
    if (failed !== null)
      return refused(
        "failed",
        `the ledger did not store the reservation (${failed}); nothing is reserved`,
      );
    const reservation: Reservation = {
      beadId: request.beadId,
      worktree,
      workspace: deps.workspace,
      globs,
      ...(request.sessionId !== undefined
        ? { sessionId: request.sessionId }
        : {}),
      acquiredAt: new Date().toISOString(),
    };
    return { ok: true, value: { reservation, already: false } };
  });
}

/**
 * Release a bead's reservation in `worktree`, whatever its spelling. The
 * `reservation.released` event repeats the held one's worktree and globs
 * exactly, which is what the ledger folds on. Nothing held is `not-held`.
 */
export async function release(
  request: { beadId: string; worktree: string },
  deps: ReservationDeps,
): Promise<ReservationOutcome<Reservation>> {
  if (!isBeadId(request.beadId))
    return refused("invalid", "beadId: expected a Beads issue id");
  if (typeof request.worktree !== "string" || request.worktree.trim() === "")
    return refused("invalid", "worktree: expected a path");
  const worktree = comparablePath(request.worktree);
  return locked(deps, () => {
    const held = activeReservations(
      { workspace: deps.workspace },
      { path: deps.ledgerPath },
    ).find(
      (r) =>
        r.beadId === request.beadId && comparablePath(r.worktree) === worktree,
    );
    if (held === undefined)
      return refused(
        "not-held",
        `${request.beadId} holds no reservation in ${request.worktree}`,
      );
    const failed = append(deps, {
      kind: "reservation.released",
      workspace: deps.workspace,
      beadId: held.beadId,
      payload: { worktree: held.worktree, globs: [...held.globs] },
    });
    return failed === null
      ? { ok: true, value: held }
      : refused(
          "failed",
          `the ledger did not store the release (${failed}); the reservation is still held`,
        );
  });
}
