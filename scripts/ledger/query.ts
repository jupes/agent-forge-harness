/**
 * Reading the ledger back: the query behind `forge:audit` and the small
 * lookups emitters need.
 */

import type {
  Executor,
  LedgerEvent,
  LedgerEventKind,
  LedgerPayloads,
  Reservation,
  SessionSummary,
} from "../../types/hearth";
import { comparableCheckout } from "../forge/runs";
import { openLedger } from "./db";

export interface EventFilter {
  /** Any spelling of the checkout path; compared in normalised form. */
  workspace?: string;
  beadId?: string;
  /** Only events tagged with the bead itself, without the session join. */
  beadExact?: boolean;
  runId?: string;
  sessionId?: string;
  /** ISO 8601; events at or after this instant. */
  since?: string;
  kinds?: readonly LedgerEventKind[];
  /** Cursor: only events with a larger id. */
  afterId?: number;
  limit?: number;
}

interface Row {
  id: number;
  ulid: string;
  ts: string;
  kind: string;
  workspace: string;
  bead_id: string | null;
  run_id: string | null;
  session_id: string | null;
  provider: string | null;
  model: string | null;
  effort: string | null;
  smith: string | null;
  payload: string;
}

function toEvent(row: Row): LedgerEvent {
  let executor: Executor | undefined;
  if (row.provider !== null && row.model !== null) {
    executor = { provider: row.provider, model: row.model };
    if (row.effort !== null) executor.effort = row.effort;
    if (row.smith !== null) executor.smith = row.smith;
    if (row.session_id !== null) executor.sessionId = row.session_id;
  }
  const event = {
    id: row.id,
    ulid: row.ulid,
    ts: row.ts,
    kind: row.kind,
    workspace: row.workspace,
    ...(row.bead_id !== null ? { beadId: row.bead_id } : {}),
    ...(row.run_id !== null ? { runId: row.run_id } : {}),
    ...(row.session_id !== null ? { sessionId: row.session_id } : {}),
    ...(executor ? { executor } : {}),
    payload: JSON.parse(row.payload) as unknown,
  };
  // justification: rows are only ever written by `appendEvent`, which validated the kind and payload.
  return event as LedgerEvent;
}

interface Clause {
  where: string[];
  params: Array<string | number>;
}

function clauses(filter: EventFilter): Clause {
  const where: string[] = [];
  const params: Array<string | number> = [];
  if (filter.workspace !== undefined) {
    where.push("workspace = ?");
    params.push(comparableCheckout(filter.workspace));
  }
  if (filter.beadId !== undefined) {
    if (filter.beadExact) {
      where.push("bead_id = ?");
      params.push(filter.beadId);
    } else {
      // A session that touched the bead brings its other events with it: the
      // tool calls and gates of that session rarely carry the bead themselves.
      // Within the workspace asked for, when there is one: which of its
      // sessions count must not depend on what another checkout recorded.
      const scoped = filter.workspace !== undefined;
      where.push(
        `(bead_id = ? OR session_id IN (SELECT session_id FROM events WHERE bead_id = ? AND session_id IS NOT NULL${scoped ? " AND workspace = ?" : ""}))`,
      );
      params.push(filter.beadId, filter.beadId);
      if (scoped) params.push(comparableCheckout(filter.workspace ?? ""));
    }
  }
  if (filter.runId !== undefined) {
    where.push("run_id = ?");
    params.push(filter.runId);
  }
  if (filter.sessionId !== undefined) {
    where.push("session_id = ?");
    params.push(filter.sessionId);
  }
  if (filter.since !== undefined) {
    where.push("ts >= ?");
    params.push(new Date(filter.since).toISOString());
  }
  if (filter.kinds !== undefined && filter.kinds.length > 0) {
    where.push(`kind IN (${filter.kinds.map(() => "?").join(", ")})`);
    params.push(...filter.kinds);
  }
  if (filter.afterId !== undefined) {
    where.push("id > ?");
    params.push(filter.afterId);
  }
  return { where, params };
}

/**
 * Events matching every given filter, ordered by `id`.
 *
 * `limit` with `afterId` is a forward page (the first `limit` events after the
 * cursor); `limit` alone is a tail (the newest `limit` events). Throws when the
 * ledger cannot be opened or `since` is not a date.
 */
export function queryEvents(
  filter: EventFilter = {},
  opts: { path?: string } = {},
): LedgerEvent[] {
  const db = openLedger(opts.path);
  const { where, params } = clauses(filter);
  const condition = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
  let sql = `SELECT * FROM events ${condition} ORDER BY id`;
  if (filter.limit !== undefined) {
    params.push(filter.limit);
    sql =
      filter.afterId !== undefined
        ? `${sql} LIMIT ?`
        : `SELECT * FROM (SELECT * FROM events ${condition} ORDER BY id DESC LIMIT ?) ORDER BY id`;
  }
  return db
    .query<Row, Array<string | number>>(sql)
    .all(...params)
    .map(toEvent);
}

/** The newest event of the given kinds for a run, or null (also when the ledger cannot be read). */
export function lastEvent(
  filter: { runId: string; kinds: readonly LedgerEventKind[] },
  opts: { path?: string } = {},
): LedgerEvent | null {
  try {
    const events = queryEvents(
      { runId: filter.runId, kinds: filter.kinds, limit: 1 },
      opts,
    );
    return events[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * The child sessions of `parent` (ids of the form `<parent>:<agent>`) that have
 * events but no `session.ended` yet. Empty when the ledger cannot be read.
 */
export function openChildSessions(
  parent: string,
  opts: { path?: string } = {},
): string[] {
  try {
    // `;` is the character after `:`, so the range is every id with the prefix `<parent>:`.
    return openLedger(opts.path)
      .query<{ session_id: string }, [string, string]>(
        `SELECT DISTINCT session_id FROM events
         WHERE session_id >= ? AND session_id < ?
           AND session_id NOT IN (
             SELECT session_id FROM events
             WHERE kind = 'session.ended' AND session_id IS NOT NULL
           )
         ORDER BY session_id`,
      )
      .all(`${parent}:`, `${parent};`)
      .map((row) => row.session_id);
  } catch {
    return [];
  }
}

export interface EventPage {
  events: LedgerEvent[];
  /** More events matched the filter than `limit`. */
  more: boolean;
}

/**
 * `limit` events and whether more matched. After a cursor the page is the
 * first `limit` and `more` means others follow; without one it is the newest
 * `limit` and `more` means older ones were left out. One more than asked for
 * is fetched: its presence is how a cut result is told from a whole one.
 */
export function queryEventPage(
  filter: EventFilter & { limit: number },
  opts: { path?: string } = {},
): EventPage {
  const fetched = queryEvents({ ...filter, limit: filter.limit + 1 }, opts);
  if (fetched.length <= filter.limit) return { events: fetched, more: false };
  return {
    events:
      filter.afterId !== undefined
        ? fetched.slice(0, filter.limit)
        : fetched.slice(1),
    more: true,
  };
}

/** The newest event id (in the workspace, when one is given); 0 when there is none. */
export function latestEventId(
  filter: { workspace?: string } = {},
  opts: { path?: string } = {},
): number {
  const scoped = filter.workspace !== undefined;
  const row = openLedger(opts.path)
    .query<{ id: number | null }, string[]>(
      `SELECT MAX(id) AS id FROM events${scoped ? " WHERE workspace = ?" : ""}`,
    )
    .get(...(scoped ? [comparableCheckout(filter.workspace ?? "")] : []));
  return row?.id ?? 0;
}

/** How many of a workspace's newest events `listSessions` looks at. */
export const SESSION_SCAN_WINDOW = 50_000;

export interface SessionFilter {
  /** Any spelling of the checkout path; compared in normalised form. */
  workspace: string;
  /** Only sessions whose newest event is not `session.ended`. */
  open?: boolean;
  /** At most this many sessions (default 100). */
  limit?: number;
  /** Look at this many of the workspace's newest events (default 50,000). */
  window?: number;
}

/**
 * The sessions seen in the newest events of a workspace, newest first.
 *
 * Bounded on purpose: the ledger keeps every tool call for 90 days, and this
 * is read on a serving thread. A session silent for the whole window is not
 * listed, and a session's executor, bead and run are the newest the window
 * holds. Nothing is asserted about a session being alive: `lastEventAt` and
 * `endedAt` are reported and the reader judges. A session whose
 * `session.started` is gone (compacted, or never recorded) has no `startedAt`,
 * `kind` or `worktree`.
 */
export function listSessions(
  filter: SessionFilter,
  opts: { path?: string } = {},
): SessionSummary[] {
  const db = openLedger(opts.path);
  const workspace = comparableCheckout(filter.workspace);
  // One pass over the window finds, per session, the id of its newest event
  // and of its newest event carrying a bead, a run and an executor. Everything
  // after that is a lookup by primary key, so the cost is the window's and
  // does not grow with how long a session has been running.
  const sessions = db
    .query<
      {
        session_id: string;
        last_ts: string;
        last_kind: string;
        bead_at: number | null;
        run_at: number | null;
        executor_at: number | null;
      },
      [string, number, number, number]
    >(
      `WITH recent AS (
         SELECT id, session_id, bead_id, run_id, provider, model FROM events
         WHERE workspace = ? ORDER BY id DESC LIMIT ?
       ), latest AS (
         SELECT session_id,
                MAX(id) AS last_id,
                MAX(CASE WHEN bead_id IS NOT NULL THEN id END) AS bead_at,
                MAX(CASE WHEN run_id IS NOT NULL THEN id END) AS run_at,
                MAX(CASE WHEN provider IS NOT NULL AND model IS NOT NULL THEN id END) AS executor_at
         FROM recent WHERE session_id IS NOT NULL GROUP BY session_id
       )
       SELECT latest.session_id AS session_id, e.ts AS last_ts, e.kind AS last_kind,
              latest.bead_at AS bead_at, latest.run_at AS run_at, latest.executor_at AS executor_at
       FROM latest JOIN events e ON e.id = latest.last_id
       WHERE (? = 0 OR e.kind != 'session.ended')
       ORDER BY latest.last_id DESC LIMIT ?`,
    )
    .all(
      workspace,
      filter.window ?? SESSION_SCAN_WINDOW,
      filter.open ? 1 : 0,
      filter.limit ?? 100,
    );

  // The partial unique index holds one row per session, so this is one probe.
  const start = db.query<{ ts: string; payload: string }, [string, string]>(
    `SELECT ts, payload FROM events INDEXED BY events_session_started_once
     WHERE session_id = ? AND kind = 'session.started' AND workspace = ?`,
  );
  const byId = db.query<
    {
      bead_id: string | null;
      run_id: string | null;
      provider: string | null;
      model: string | null;
      effort: string | null;
      smith: string | null;
    },
    [number]
  >(
    "SELECT bead_id, run_id, provider, model, effort, smith FROM events WHERE id = ?",
  );

  return sessions.map((row) => {
    const id = row.session_id;
    const began = start.get(id, workspace);
    // justification: the row was written by `appendEvent`, which validated this payload shape.
    const origin = (
      began ? JSON.parse(began.payload) : {}
    ) as LedgerPayloads["session.started"];
    const by = row.executor_at === null ? null : byId.get(row.executor_at);
    const beadId = row.bead_at === null ? null : byId.get(row.bead_at)?.bead_id;
    const runId = row.run_at === null ? null : byId.get(row.run_at)?.run_id;
    return {
      sessionId: id,
      workspace,
      ...(origin.kind !== undefined ? { kind: origin.kind } : {}),
      ...(origin.worktree !== undefined ? { worktree: origin.worktree } : {}),
      ...(origin.parentSessionId !== undefined
        ? { parentSessionId: origin.parentSessionId }
        : {}),
      ...(began ? { startedAt: began.ts } : {}),
      lastEventAt: row.last_ts,
      ...(row.last_kind === "session.ended" ? { endedAt: row.last_ts } : {}),
      ...(by?.provider && by.model
        ? {
            executor: {
              provider: by.provider,
              model: by.model,
              ...(by.effort !== null ? { effort: by.effort } : {}),
              ...(by.smith !== null ? { smith: by.smith } : {}),
              sessionId: id,
            },
          }
        : {}),
      ...(beadId ? { beadId } : {}),
      ...(runId ? { runId } : {}),
    };
  });
}

/**
 * The file claims held now: each `reservation.acquired` with no later
 * `reservation.released` for the same bead and worktree, oldest first. An
 * event that names no bead cannot form a `Reservation` and is left out.
 */
export function activeReservations(
  filter: { workspace: string },
  opts: { path?: string } = {},
): Reservation[] {
  const held = new Map<string, Reservation>();
  // By the kind index: reservation events are few, the workspace's events are
  // many, and left to itself the planner walks the workspace.
  const events = openLedger(opts.path)
    .query<Row, [string]>(
      `SELECT * FROM events INDEXED BY events_kind
       WHERE kind IN ('reservation.acquired', 'reservation.released') AND workspace = ?
       ORDER BY id`,
    )
    .all(comparableCheckout(filter.workspace))
    .map(toEvent);
  for (const event of events) {
    if (
      event.kind !== "reservation.acquired" &&
      event.kind !== "reservation.released"
    )
      continue;
    if (event.beadId === undefined) continue;
    const key = `${event.beadId}\n${event.payload.worktree}`;
    // Deleted first either way, so a claim taken again sorts by its new time.
    held.delete(key);
    if (event.kind === "reservation.acquired")
      held.set(key, {
        beadId: event.beadId,
        worktree: event.payload.worktree,
        workspace: event.workspace,
        globs: event.payload.globs,
        ...(event.sessionId !== undefined
          ? { sessionId: event.sessionId }
          : {}),
        acquiredAt: event.ts,
      });
  }
  return [...held.values()];
}
