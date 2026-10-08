/**
 * Reading the ledger back: the query behind `forge:audit` and the small
 * lookups emitters need.
 */

import type {
  Executor,
  LedgerEvent,
  LedgerEventKind,
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
      where.push(
        "(bead_id = ? OR session_id IN (SELECT session_id FROM events WHERE bead_id = ? AND session_id IS NOT NULL))",
      );
      params.push(filter.beadId, filter.beadId);
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
