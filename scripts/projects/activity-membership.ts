import { comparableCheckout } from "../forge/runs";
import { openLedger } from "../ledger/db";

/** Candidate/filter membership only: historical tags do not authorize later untagged rows. */
export function activitySessionMembership(
  workspace: string,
  beadIds: readonly string[],
  ledgerPath: string,
): { sessions: string[]; complete: boolean } {
  if (beadIds.length === 0) return { sessions: [], complete: true };
  if (beadIds.length > 5000)
    throw Error("This project's membership exceeds the bounded Activity read.");
  const rows = openLedger(ledgerPath)
    .query<{ sessionId: string }, string[]>(
      `SELECT session_id AS sessionId FROM events
       WHERE workspace = ? AND bead_id IN (${beadIds.map(() => "?").join(",")})
       AND session_id IS NOT NULL
       GROUP BY session_id ORDER BY MAX(id) DESC LIMIT 1001`,
    )
    .all(comparableCheckout(workspace), ...beadIds);
  return {
    sessions: rows.slice(0, 1000).map((row) => row.sessionId),
    complete: rows.length <= 1000,
  };
}

/** Effective latest explicit assignment at each untagged row; bounded to one Activity page. */
export function activityRowAssignments(
  workspace: string,
  rows: readonly { id: number; sessionId: string }[],
  ledgerPath: string,
): Map<number, string | null> {
  if (rows.length === 0) return new Map();
  if (rows.length > 200)
    throw Error("Activity assignment read exceeds one page.");
  const values: Array<string | number> = [];
  for (const row of rows) values.push(row.id, row.sessionId);
  values.push(comparableCheckout(workspace));
  const found = openLedger(ledgerPath)
    .query<{ eventId: number; beadId: string | null }, Array<string | number>>(
      `WITH candidates(eventId, sessionId) AS (VALUES ${rows.map(() => "(?,?)").join(",")})
       SELECT candidates.eventId, (SELECT bead_id FROM events
         WHERE workspace = ? AND session_id = candidates.sessionId
         AND bead_id IS NOT NULL AND id <= candidates.eventId
         ORDER BY id DESC LIMIT 1) AS beadId
       FROM candidates`,
    )
    .all(...values);
  return new Map(found.map((row) => [row.eventId, row.beadId]));
}
