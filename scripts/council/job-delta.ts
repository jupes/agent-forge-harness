/**
 * A council job sent as changes: the whole job once, then for each update
 * only what changed since the job the reader already has.
 *
 * The service only appends to a job's `events` and `discussion`, so a delta
 * carries the entries appended to each, and, of every other field, the ones
 * whose value changed (`set`) or that the job no longer has (`unset`). When
 * the newer job is not the older one plus appended entries (another run, an
 * array that shrank, a kept event with another `seq`), there is no delta and
 * the reader is sent the whole job instead.
 *
 * Pure, with type imports only, so a page can bundle it to apply deltas.
 */

import type { CouncilServiceJob } from "./service";
import type { CouncilDiscussionRound, CouncilEvent } from "./types";

/** The fields of a job other than the two lists a delta appends to. */
type JobFields = Omit<CouncilServiceJob, "events" | "discussion">;

export type CouncilJobDelta = {
  runId: string;
  /** Events appended since the job the reader has, oldest first. */
  events: CouncilEvent[];
  /** Discussion rounds appended since then, oldest first. */
  discussion: CouncilDiscussionRound[];
  /** Each other field whose value changed, with its new value. */
  set: Partial<JobFields>;
  /** Each other field the job no longer has. */
  unset: Array<keyof JobFields>;
};

const APPENDED = new Set<string>(["events", "discussion"]);

/** The fields of a job a delta compares, in a fixed order. */
function fieldsOf(job: CouncilServiceJob): Array<keyof JobFields> {
  return (Object.keys(job) as Array<keyof CouncilServiceJob>).filter(
    (key): key is keyof JobFields => !APPENDED.has(key),
  );
}

/** Whether `after` keeps every entry of `before` and only adds to the end. */
function appendsTo<T>(
  before: readonly T[],
  after: readonly T[],
  same: (a: T, b: T) => boolean,
): boolean {
  if (after.length < before.length) return false;
  const last = before.length - 1;
  return last < 0 || same(before[last] as T, after[last] as T);
}

/**
 * What changed from `before` to `after`, or null when `after` is not
 * `before` plus appended events and rounds: then send the whole job.
 */
export function councilJobDelta(
  before: CouncilServiceJob,
  after: CouncilServiceJob,
): CouncilJobDelta | null {
  if (before.runId !== after.runId) return null;
  const beforeRounds = before.discussion ?? [];
  const afterRounds = after.discussion ?? [];
  if (
    !appendsTo(before.events, after.events, (a, b) => a.seq === b.seq) ||
    !appendsTo(
      beforeRounds,
      afterRounds,
      (a, b) => a.completedAt === b.completedAt && a.stage === b.stage,
    )
  )
    return null;
  const set: Partial<Record<keyof JobFields, unknown>> = {};
  for (const key of fieldsOf(after))
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key]))
      set[key] = after[key];
  return {
    runId: after.runId,
    events: after.events.slice(before.events.length),
    discussion: afterRounds.slice(beforeRounds.length),
    // justification: each value was read from `after` under its own key.
    set: set as Partial<JobFields>,
    unset: fieldsOf(before).filter((key) => !(key in after)),
  };
}

/** The job a reader has, brought up to date with a delta made from it. */
export function applyCouncilJobDelta(
  job: CouncilServiceJob,
  delta: CouncilJobDelta,
): CouncilServiceJob {
  const next: CouncilServiceJob = {
    ...job,
    ...delta.set,
    events: [...job.events, ...delta.events],
  };
  if (job.discussion !== undefined || delta.discussion.length > 0)
    next.discussion = [...(job.discussion ?? []), ...delta.discussion];
  for (const key of delta.unset) delete next[key];
  return next;
}
