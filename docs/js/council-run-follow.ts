/**
 * Following a council run on the Council page: the run's progress stream,
 * read as the whole job once and then as deltas.
 *
 * The page asks for `?deltas=1`. The hearth then sends the whole job as the
 * first message (`snapshot`) and, for each update after it, only what changed
 * since the job it last sent on that connection (`delta`, built by
 * `scripts/council/job-delta.ts`), or the whole job again when an update is
 * not that job plus appended entries. The views read the whole job (the last
 * event of each seat, every event, the discussion), so the page rebuilds it
 * with `applyCouncilJobDelta`.
 *
 * A delta is made from the job the hearth last sent on this connection, so it
 * is applied to the job this connection last received, held here per
 * connection, and never to a job the page got some other way (a run opened
 * from the history, a run read again) or on another connection: that one may
 * be newer or older, and applying a delta to it would repeat or lose entries.
 * A delta that cannot be applied is answered by reading the run again: no job
 * yet on this connection (or the last whole job could not be read), another
 * run's, unreadable, or not what follows the job held (the next event number
 * after the last one held, and no discussion round already held), so a delta
 * sent twice or out of order is never applied. A new connection starts with
 * the whole job, which replaces the one held, and a message from a connection
 * that is no longer the current one is ignored. Reading again is capped: after
 * `MAX_FALLBACKS` reads in a row without a connection that delivered a second
 * good message, following stops and the page is told the connection was lost.
 *
 * The stream is read with the caller's transport, not the browser's
 * event-source class: a run's stream needs the operator token, which that
 * class cannot send. Nothing here reaches the network itself, so the rules are
 * tested with a stand-in stream.
 */

import {
  applyCouncilJobDelta,
  type CouncilJobDelta,
} from "../../scripts/council/job-delta";
import type { CouncilServiceJob } from "../../scripts/council/service";
import type { StreamTransport, Timers } from "./use-stream";

/** How long to wait before following a running job's stream again after it stopped. */
export const RECONNECT_MS = 1_000;

/**
 * Reads of the run in a row, for a stream that stopped or a delta that could
 * not be applied, before following gives up.
 */
export const MAX_FALLBACKS = 5;

export const UNREADABLE_UPDATE =
  "A progress update could not be read. Reopen the run from history.";
export const CONNECTION_LOST =
  "Connection lost. The council may still be running; refresh to reconnect.";

export const isActive = (job: CouncilServiceJob): boolean =>
  job.status === "running" || job.status === "cancelling";

/** A run's progress stream, asking for the whole job once and then deltas. */
export function councilRunEventsUrl(api: string, runId: string): string {
  return `${api}/runs/${encodeURIComponent(runId)}/events?deltas=1`;
}

function parsed(data: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(data);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** The job a `snapshot` message carries, or null when it is not one. */
function jobFrom(data: string): CouncilServiceJob | null {
  const value = parsed(data);
  if (
    value === null ||
    typeof value["runId"] !== "string" ||
    typeof value["status"] !== "string" ||
    !Array.isArray(value["events"])
  )
    return null;
  // justification: the fields the page reads first were checked above.
  return value as CouncilServiceJob;
}

/** The delta a `delta` message carries, or null when it is not one. */
function deltaFrom(data: string): CouncilJobDelta | null {
  const value = parsed(data);
  if (value === null) return null;
  const { runId, events, discussion, set, unset } = value;
  if (
    typeof runId !== "string" ||
    !Array.isArray(events) ||
    !Array.isArray(discussion) ||
    !Array.isArray(unset) ||
    typeof set !== "object" ||
    set === null ||
    Array.isArray(set)
  )
    return null;
  // justification: the fields the job rebuild reads were checked above.
  return value as CouncilJobDelta;
}

/**
 * Whether what the delta appends comes right after what `held` has: its first
 * event is the next number after the last one held (the service numbers a
 * run's events 0, 1, 2 … with none left out, `emit` in
 * `scripts/council/engine.ts`; a job with no event held takes any first
 * number), the rest follow one by one, and no round is one `held` already has.
 * A delta sent twice, or one made for a later job that arrives first, fails
 * this.
 */
function continues(held: CouncilServiceJob, delta: CouncilJobDelta): boolean {
  let previous: number | undefined = held.events.at(-1)?.seq;
  for (const item of delta.events) {
    const seq: unknown = item?.seq;
    if (
      typeof seq !== "number" ||
      (previous !== undefined && seq !== previous + 1)
    )
      return false;
    previous = seq;
  }
  const kept = held.discussion ?? [];
  return delta.discussion.every(
    (item) =>
      !kept.some(
        (have) =>
          have?.completedAt === item?.completedAt &&
          have?.stage === item?.stage,
      ),
  );
}

/** The job the delta brings `held` to, or null when it cannot be applied to it. */
function applied(
  held: CouncilServiceJob | null,
  data: string,
): CouncilServiceJob | null {
  if (held === null) return null;
  const delta = deltaFrom(data);
  if (delta === null || delta.runId !== held.runId || !continues(held, delta))
    return null;
  return applyCouncilJobDelta(held, delta);
}

const REAL_TIMERS: Timers = {
  set: (run, ms) => setTimeout(run, ms),
  // justification: the handle is whatever `set` above returned.
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface CouncilRunFollowOptions {
  /** The run followed: a job of another run is never taken for it. */
  runId: string;
  /** Opens the run's stream (`councilRunEventsUrl`); called again for each connection. */
  transport: StreamTransport;
  /** Reads the run whole. */
  readRun(): Promise<CouncilServiceJob>;
  /** The job as it stands now. */
  onJob(job: CouncilServiceJob): void;
  onError(message: string): void;
  /** The run is no longer active: the list of runs is out of date. */
  onFinished(): void;
  retryMs?: number;
  timers?: Timers;
}

/** One connection to the run's stream. */
interface Link {
  /** The job this connection last received: what its next delta is made from. */
  held: CouncilServiceJob | null;
  /** The messages of this connection that were taken. */
  taken: number;
  handle: { close(): void } | null;
}

/** Follow a running job until it stops running or `close()` is called. */
export function followCouncilRun(options: CouncilRunFollowOptions): {
  close(): void;
} {
  const { runId, transport, readRun, onJob, onError, onFinished } = options;
  const retryMs = options.retryMs ?? RECONNECT_MS;
  const timers = options.timers ?? REAL_TIMERS;
  let closed = false;
  let retry: unknown = null;
  /** The connection in use; anything another connection sends is ignored. */
  let link: Link | null = null;
  /** Reads of the run in a row since a connection made progress. */
  let fallbacks = 0;

  const dropLink = (): void => {
    const old = link;
    link = null;
    old?.handle?.close();
  };

  const take = (from: Link, job: CouncilServiceJob): void => {
    from.held = job;
    from.taken += 1;
    // A connection that delivered a second good message was making progress.
    if (from.taken > 1) fallbacks = 0;
    onJob(job);
    if (!isActive(job)) {
      closed = true;
      dropLink();
      onFinished();
    }
  };

  // The stream stopped while the run was going, or sent a delta that cannot
  // be applied: read the run, and follow it again while it still is going.
  const readAgain = (): void => {
    if (closed) return;
    dropLink();
    fallbacks += 1;
    if (fallbacks > MAX_FALLBACKS) {
      closed = true;
      onError(CONNECTION_LOST);
      return;
    }
    void readRun()
      .then((fresh) => {
        if (closed) return;
        onJob(fresh);
        if (isActive(fresh)) retry = timers.set(connect, retryMs);
        else {
          closed = true;
          onFinished();
        }
      })
      .catch(() => {
        if (!closed) onError(CONNECTION_LOST);
      });
  };

  function connect(): void {
    const mine: Link = { held: null, taken: 0, handle: null };
    link = mine;
    mine.handle = transport(null, {
      onOpen: () => {},
      onActivity: () => {},
      onMessage: (message) => {
        if (closed || link !== mine) return;
        if (message.event === "snapshot") {
          const snapshot = jobFrom(message.data);
          if (snapshot === null || snapshot.runId !== runId) {
            // What the next delta would be applied to is no longer known.
            mine.held = null;
            onError(UNREADABLE_UPDATE);
          } else take(mine, snapshot);
        } else if (message.event === "delta") {
          const next = applied(mine.held, message.data);
          if (next === null) readAgain();
          else take(mine, next);
        }
      },
      onEnd: () => {
        if (!closed && link === mine) readAgain();
      },
    });
    if (link !== mine) mine.handle.close();
  }

  connect();
  return {
    close() {
      closed = true;
      if (retry !== null) timers.clear(retry);
      dropLink();
    },
  };
}
