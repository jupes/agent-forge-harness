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

import { parseFileMap } from "./filemap";

// ── Overlap ─────────────────────────────────────────────────────────────────

const WILDCARD = /[*?]/;

/** A glob as segments, lowercased, with the covering rule applied. */
function segmentsOf(glob: string): string[] {
  const segments = glob
    .toLowerCase()
    .split("/")
    .filter((segment) => segment !== "");
  const last = segments.at(-1);
  if (last !== undefined && last !== "**" && !WILDCARD.test(last))
    segments.push("**");
  return segments;
}

/** Whether some string matches both segment patterns (`*` any run, `?` one character). */
function segmentsMeet(p: string, q: string): boolean {
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

/** Whether some path matches both globs. */
export function globsOverlap(a: string, b: string): boolean {
  const as = segmentsOf(a);
  const bs = segmentsOf(b);
  const memo = new Map<number, boolean>();
  const meet = (i: number, j: number): boolean => {
    const key = i * (bs.length + 1) + j;
    const known = memo.get(key);
    if (known !== undefined) return known;
    let result: boolean;
    if (i === as.length && j === bs.length) result = true;
    else if (as[i] === "**")
      // `**` matches no segment, or one more of the other side's.
      result = meet(i + 1, j) || (j < bs.length && meet(i, j + 1));
    else if (bs[j] === "**")
      result = meet(i, j + 1) || (i < as.length && meet(i + 1, j));
    else if (i === as.length || j === bs.length) result = false;
    else
      result =
        segmentsMeet(as[i] as string, bs[j] as string) && meet(i + 1, j + 1);
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
    if (map.ok) return { globs: map.globs, conservative: false };
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
