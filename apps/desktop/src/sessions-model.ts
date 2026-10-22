import type { SessionSummary } from "../../../types/hearth";

export type SessionGroup = "ended-today" | "observed" | "older";
export interface SessionFilters {
  provider?: string;
  kind?: string;
  group?: string;
  bead?: string;
  smith?: string;
  search?: string;
}
export interface SessionRow {
  session: SessionSummary;
  group: SessionGroup;
  depth: number;
}
export const SESSION_GROUPS: readonly { id: SessionGroup; label: string }[] = [
  { id: "ended-today", label: "Ended today" },
  { id: "observed", label: "Observed" },
  { id: "older", label: "Older" },
];

export function sessionGroup(
  session: SessionSummary,
  asOf: string,
): SessionGroup {
  return session.endedAt
    ? session.endedAt.slice(0, 10) === asOf.slice(0, 10)
      ? "ended-today"
      : "older"
    : "observed";
}

/** The ledger does not prove running/idle/permission state or an unreported title. */
export function sessionRows(
  sessions: readonly SessionSummary[],
  filters: SessionFilters,
  asOf: string,
): SessionRow[] {
  const byId = new Map<string, SessionSummary>();
  for (const session of sessions) {
    const previous = byId.get(session.sessionId);
    if (
      !previous ||
      Date.parse(session.lastEventAt) > Date.parse(previous.lastEventAt)
    )
      byId.set(session.sessionId, session);
  }
  const query = filters.search?.trim().toLocaleLowerCase() ?? "";
  const selected = [...byId.values()]
    .filter(
      (session) =>
        (!filters.provider ||
          session.executor?.provider === filters.provider) &&
        (!filters.kind || session.kind === filters.kind) &&
        (!filters.group || sessionGroup(session, asOf) === filters.group) &&
        (!filters.bead || session.beadId === filters.bead) &&
        (!filters.smith || session.executor?.smith === filters.smith) &&
        (!query ||
          [
            session.sessionId,
            session.beadId,
            session.executor?.provider,
            session.executor?.model,
            session.executor?.smith,
            session.worktree,
          ]
            .filter(Boolean)
            .join(" ")
            .toLocaleLowerCase()
            .includes(query)),
    )
    .sort(
      (a, b) =>
        Date.parse(b.lastEventAt) - Date.parse(a.lastEventAt) ||
        a.sessionId.localeCompare(b.sessionId),
    );
  const out: SessionRow[] = [];
  for (const group of SESSION_GROUPS) {
    const rows = selected.filter(
      (session) => sessionGroup(session, asOf) === group.id,
    );
    const ids = new Set(rows.map((session) => session.sessionId));
    const children = new Map<string, SessionSummary[]>();
    for (const session of rows)
      if (session.parentSessionId && ids.has(session.parentSessionId)) {
        const siblings = children.get(session.parentSessionId) ?? [];
        siblings.push(session);
        children.set(session.parentSessionId, siblings);
      }
    const visited = new Set<string>();
    const visit = (session: SessionSummary, depth: number) => {
      if (visited.has(session.sessionId)) return;
      visited.add(session.sessionId);
      out.push({ session, group: group.id, depth: Math.min(depth, 8) });
      for (const child of children.get(session.sessionId) ?? [])
        visit(child, depth + 1);
    };
    for (const session of rows)
      if (!session.parentSessionId || !ids.has(session.parentSessionId))
        visit(session, 0);
    for (const session of rows) visit(session, 0); // Cycles still appear once, without inventing a parent.
  }
  return out;
}
