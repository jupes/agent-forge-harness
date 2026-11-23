import type { Reservation } from "../../types/hearth";

export interface ReservationFact {
  kind: "reservation.acquired" | "reservation.released";
  beadId?: string;
  sessionId?: string;
  workspace: string;
  ts: string;
  payload: { worktree: string; globs: string[] };
}

/** Complete ordered acquire/release fold; the caller establishes source completeness. */
export function foldReservations(
  events: Iterable<ReservationFact>,
): Reservation[] {
  const held = new Map<string, Reservation>();
  for (const event of events) {
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
