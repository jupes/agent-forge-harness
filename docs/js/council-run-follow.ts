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
 * is applied to the job this connection last received, held here, and never to
 * a job the page got some other way (a run opened from the history, a run read
 * again): that one may be newer or older, and applying a delta to it would
 * repeat or lose entries. A delta that cannot be applied (no job yet on this
 * connection, another run's, or unreadable) is answered by reading the run
 * again. A new connection starts with the whole job, which replaces the one
 * held.
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

/** The job the delta brings `held` to, or null when it cannot be applied to it. */
function applied(
  held: CouncilServiceJob | null,
  data: string,
): CouncilServiceJob | null {
  if (held === null) return null;
  const delta = deltaFrom(data);
  if (delta === null || delta.runId !== held.runId) return null;
  return applyCouncilJobDelta(held, delta);
}

const REAL_TIMERS: Timers = {
  set: (run, ms) => setTimeout(run, ms),
  // justification: the handle is whatever `set` above returned.
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface CouncilRunFollowOptions {
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

/** Follow a running job until it stops running or `close()` is called. */
export function followCouncilRun(options: CouncilRunFollowOptions): {
  close(): void;
} {
  const { transport, readRun, onJob, onError, onFinished } = options;
  const retryMs = options.retryMs ?? RECONNECT_MS;
  const timers = options.timers ?? REAL_TIMERS;
  let closed = false;
  let connection: { close(): void } | null = null;
  let retry: unknown = null;
  /** The job this connection last received: what its next delta is made from. */
  let held: CouncilServiceJob | null = null;

  const show = (job: CouncilServiceJob): void => {
    held = job;
    onJob(job);
    if (!isActive(job)) {
      closed = true;
      connection?.close();
      onFinished();
    }
  };

  // The stream stopped while the run was going, or sent a delta that cannot
  // be applied: read the run, and follow it again while it still is going.
  const readAgain = (): void => {
    if (closed) return;
    connection?.close();
    held = null;
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
    held = null;
    connection = transport(null, {
      onOpen: () => {},
      onActivity: () => {},
      onMessage: (message) => {
        if (closed) return;
        if (message.event === "snapshot") {
          const snapshot = jobFrom(message.data);
          if (snapshot === null) onError(UNREADABLE_UPDATE);
          else show(snapshot);
        } else if (message.event === "delta") {
          const next = applied(held, message.data);
          if (next === null) readAgain();
          else show(next);
        }
      },
      onEnd: readAgain,
    });
  }

  connect();
  return {
    close() {
      closed = true;
      if (retry !== null) timers.clear(retry);
      connection?.close();
    },
  };
}
