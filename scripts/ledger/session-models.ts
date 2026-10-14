/**
 * The last model and effort seen for each session.
 *
 * A cache table, not an event: the session's own hooks keep it current, and
 * emitters that run outside the session (a phase gate, a quality gate) read it
 * to tag what they record. Neither function throws.
 */

import { openLedger } from "./db";

export interface SessionModel {
  provider: string;
  model: string;
  effort?: string;
}

interface Row {
  provider: string;
  model: string;
  effort: string | null;
}

/** The cached model for a session, or null when none is known or the ledger cannot be read. */
export function getSessionModel(
  sessionId: string,
  opts: { path?: string } = {},
): SessionModel | null {
  try {
    const row = openLedger(opts.path)
      .query<Row, [string]>(
        "SELECT provider, model, effort FROM session_models WHERE session_id = ?",
      )
      .get(sessionId);
    if (!row) return null;
    return {
      provider: row.provider,
      model: row.model,
      ...(row.effort !== null ? { effort: row.effort } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * The models cached for a session's subagents: each child session the hooks
 * key `<session>:<agent id>` that has a model of its own. Null when the
 * ledger cannot be read, which is not the same as no subagents.
 */
export function getSubagentModels(
  sessionId: string,
  opts: { path?: string } = {},
): Array<SessionModel & { sessionId: string }> | null {
  const prefix = `${sessionId}:`;
  try {
    const rows = openLedger(opts.path)
      .query<Row & { session_id: string }, [number, string]>(
        "SELECT session_id, provider, model, effort FROM session_models WHERE substr(session_id, 1, ?) = ? ORDER BY session_id",
      )
      // SQLite counts characters, not UTF-16 units.
      .all([...prefix].length, prefix);
    return rows.map((row) => ({
      sessionId: row.session_id,
      provider: row.provider,
      model: row.model,
      ...(row.effort !== null ? { effort: row.effort } : {}),
    }));
  } catch {
    return null;
  }
}

/**
 * Record a session's current model. An absent `effort` keeps the one already
 * known: the model is reported earlier and more often than the effort.
 */
export function setSessionModel(
  entry: SessionModel & { sessionId: string },
  opts: { path?: string; now?: () => Date } = {},
): boolean {
  try {
    openLedger(opts.path)
      .query(
        `INSERT INTO session_models (session_id, provider, model, effort, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET
           provider = excluded.provider,
           model = excluded.model,
           effort = COALESCE(excluded.effort, session_models.effort),
           updated_at = excluded.updated_at`,
      )
      .run(
        entry.sessionId,
        entry.provider,
        entry.model,
        entry.effort ?? null,
        (opts.now?.() ?? new Date()).toISOString(),
      );
    return true;
  } catch (error) {
    console.error(
      `ledger: session model not recorded: ${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }
}
