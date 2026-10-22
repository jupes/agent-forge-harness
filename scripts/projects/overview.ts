import type {
  LedgerEvent,
  ProviderUsage,
  Reservation,
} from "../../types/hearth";
import { PROVIDER_USAGE_COUNTS } from "../../types/hearth";
import type {
  ProjectObservation,
  ProjectOverview,
} from "../../types/project-overview";
import type { ProjectRecord } from "../../types/projects";
import type { ListedShift } from "../scheduler/shift-store";
import { selectProjectBeads, workspaceKey } from "./scope";
import { type ProjectSources, summarizeProject } from "./summary";

const DAY = 86_400_000;
export interface ProjectHistory {
  events: LedgerEvent[] | null;
  more: boolean;
  reservations: Reservation[] | null;
  shifts: ListedShift[] | null;
}
export function projectHistoryStart(asOf: string): string {
  return new Date(
    Date.parse(`${asOf.slice(0, 10)}T00:00:00.000Z`) - 29 * DAY,
  ).toISOString();
}

/** Every event must carry its own project bead binding. Session reuse grants no history access. */
export function buildProjectOverview(
  project: ProjectRecord,
  sources: ProjectSources,
  history: ProjectHistory,
): ProjectOverview {
  const summary = summarizeProject(project, sources);
  const beads = selectProjectBeads(
    project,
    sources.workspace,
    sources.issues ?? [],
  );
  const ids = new Set(beads.map((bead) => bead.id));
  const bound = (event: LedgerEvent) =>
    workspaceKey(event.workspace) === workspaceKey(sources.workspace) &&
    event.beadId !== undefined &&
    ids.has(event.beadId);
  const start = Date.parse(projectHistoryStart(sources.asOf));
  const end = Date.parse(sources.asOf);
  const events = (history.events ?? []).filter(
    (event) =>
      bound(event) &&
      Date.parse(event.ts) >= start &&
      Date.parse(event.ts) <= end,
  );
  const days = new Map<string, Set<string>>();
  for (let index = 0; index < 30; index++)
    days.set(
      new Date(start + index * DAY).toISOString().slice(0, 10),
      new Set(),
    );
  for (const event of events)
    if (
      event.kind === "bead.transitioned" &&
      "action" in event.payload &&
      event.payload.action === "close" &&
      event.beadId
    )
      days.get(event.ts.slice(0, 10))?.add(event.beadId);
  const usage = new Map<
    string,
    { provider: string; sessions: number; usage: ProviderUsage }
  >();
  const counted = new Set<string>();
  const weekStart = end - 7 * DAY;
  for (const event of [...events].sort((a, b) => b.id - a.id)) {
    if (
      event.kind !== "session.ended" ||
      !event.sessionId ||
      !event.payload.usage ||
      Date.parse(event.ts) < weekStart ||
      counted.has(event.sessionId)
    )
      continue;
    counted.add(event.sessionId);
    const provider = event.executor?.provider ?? "unknown";
    const row = usage.get(provider) ?? { provider, sessions: 0, usage: {} };
    row.sessions++;
    for (const key of [...PROVIDER_USAGE_COUNTS, "costUsd"] as const) {
      const value = event.payload.usage[key];
      if (value !== undefined) row.usage[key] = (row.usage[key] ?? 0) + value;
    }
    usage.set(provider, row);
  }
  const observation = <T>(
    data: T | null,
    source: string,
    complete: boolean,
    reason: string | null,
  ): ProjectObservation<T> => ({
    data,
    source,
    asOf: sources.asOf,
    complete,
    reason,
  });
  const historyAvailable = history.events !== null && summary.complete;
  return {
    summary,
    beads,
    epics: beads
      .filter((bead) => bead.type === "epic")
      .map((epic) => {
        const selected = selectProjectBeads(
          {
            ...project,
            workspaces: project.workspaces.map((scope) => ({
              ...scope,
              epicIds: [epic.id],
            })),
          },
          sources.workspace,
          sources.issues ?? [],
        );
        return {
          id: epic.id,
          title: epic.title,
          closed: selected.filter((bead) => bead.status === "closed").length,
          total: selected.length,
        };
      }),
    reservations: observation(
      history.reservations?.filter(
        (row) =>
          ids.has(row.beadId) &&
          workspaceKey(row.workspace) === workspaceKey(sources.workspace),
      ) ?? null,
      "Workspace ledger reservations",
      history.reservations !== null && summary.complete,
      history.reservations === null ? "Reservation read unavailable." : null,
    ),
    shifts: observation(
      history.shifts?.filter(
        (row) =>
          workspaceKey(row.workspace) === workspaceKey(sources.workspace) &&
          row.options.epic !== undefined &&
          ids.has(row.options.epic),
      ) ?? null,
      "Explicit epic-bound shift records",
      false,
      "Unbound shifts and unreadable records are not attributed to this project.",
    ),
    throughput: observation(
      historyAvailable
        ? [...days].map(([date, closed]) => ({ date, count: closed.size }))
        : null,
      "Closures recorded by this hearth · 30 UTC days",
      historyAvailable && !history.more,
      !historyAvailable
        ? "Project history unavailable."
        : history.more
          ? "Only the newest 10,000 history events were read."
          : "Tracker changes made outside this hearth are not recorded here.",
    ),
    usage: observation(
      historyAvailable ? [...usage.values()] : null,
      "Provider-reported session-end usage · last 7 days",
      false,
      "Reported usage only; live sessions, unpriced work and changes outside the hearth may be absent. No allowance or subscription total is inferred.",
    ),
  };
}
