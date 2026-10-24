import type { BeadsDependency, BeadsIssue } from "../../types/beads";
import type { OwnedCodingSessionRecord } from "../../types/codex-owned-task";
import {
  QUEUE_STATES,
  type QueueEntry,
  type QueueState,
  type SessionSummary,
} from "../../types/hearth";
import type { ProjectSummary } from "../../types/project-summary";
import type { ProjectRecord } from "../../types/projects";
import type { BdExportRow } from "../beads-dashboard";
import { buildDerivedFromIssuesAndDeps } from "../beads-dashboard";
import type { RunSummary } from "../forge/runs";
import { selectProjectBeads, workspaceKey } from "./scope";

export interface ProjectSources {
  /** Server-only raw fields from the same checked live export; never sent as an unscoped payload. */
  beadRows?: readonly BdExportRow[];
  workspace: string;
  asOf: string;
  issues: BeadsIssue[] | null;
  dependencies?: BeadsDependency[];
  queue: QueueEntry[] | null;
  sessions: SessionSummary[];
  sessionsComplete: boolean;
  problems: string[];
  runs?: RunSummary[];
  checkout?: string;
  /** Trusted private registry membership, not inferred from session ids or ledger content. */
  ownedSessions?: OwnedCodingSessionRecord[];
}

/** Membership is established before any aggregation or object link is emitted. */
export function summarizeProject(
  project: ProjectRecord,
  source: ProjectSources,
): ProjectSummary {
  const scope = project.workspaces.find(
    (item) => workspaceKey(item.root) === workspaceKey(source.workspace),
  );
  const problems = [...source.problems];
  if (!scope)
    problems.push("This hearth does not serve a workspace in this project.");
  if (
    project.workspaces.some(
      (item) => workspaceKey(item.root) !== workspaceKey(source.workspace),
    )
  )
    problems.push("Other project workspaces are unavailable from this hearth.");
  const issues = source.issues ?? [];
  const members = selectProjectBeads(project, source.workspace, issues);
  const ids = new Set(members.map((item) => item.id));
  const missing =
    scope?.epicIds.filter(
      (id) => !issues.some((item) => item.id === id && item.type === "epic"),
    ) ?? [];
  if (missing.length)
    problems.push(
      "One or more selected epics are absent from the tracker read.",
    );
  const scoped =
    Boolean(scope) && source.issues !== null && missing.length === 0;
  // Tracker completeness is independent of ledger/session availability.
  const complete = scoped && project.workspaces.length === 1;
  const queueRows = (source.queue ?? []).filter(
    (entry) => ids.has(entry.beadId) && entry.backed === true,
  );
  const queue = Object.fromEntries(
    QUEUE_STATES.map((state) => [
      state,
      new Set(
        queueRows
          .filter((entry) => entry.state === state)
          .map((entry) => entry.beadId),
      ).size,
    ]),
  ) as Record<QueueState, number>;
  const blocked = new Set(
    buildDerivedFromIssuesAndDeps(
      issues,
      source.dependencies ?? [],
    ).blocked.map((item) => item.id),
  );
  const sessions = source.sessions.filter(
    (session) =>
      workspaceKey(session.workspace) === workspaceKey(source.workspace) &&
      ((session.beadId !== undefined && ids.has(session.beadId)) ||
        (source.ownedSessions ?? []).some(
          (owned) =>
            owned.id === session.sessionId &&
            owned.beadId === session.beadId &&
            session.runId === undefined &&
            (session.worktree === undefined ||
              workspaceKey(session.worktree) ===
                workspaceKey(owned.worktree)) &&
            owned.projectId === project.id &&
            workspaceKey(owned.workspace) === workspaceKey(source.workspace) &&
            scope?.repositories.some(
              (path) => workspaceKey(path) === workspaceKey(owned.repository),
            ),
        )),
  );
  const times = [
    ...members.map((item) => item.updatedAt),
    ...sessions.map((item) => item.lastEventAt),
  ]
    .filter((time) => Number.isFinite(Date.parse(time)))
    .sort((a, b) => Date.parse(b) - Date.parse(a));
  return {
    projectId: project.id,
    workspace: source.workspace,
    asOf: source.asOf,
    complete,
    problems,
    beads: complete
      ? {
          open: members.filter((item) => item.status === "open").length,
          inProgress: members.filter((item) => item.status === "in_progress")
            .length,
          closed: members.filter((item) => item.status === "closed").length,
          blocked: members.filter(
            (item) => item.status === "blocked" || blocked.has(item.id),
          ).length,
        }
      : null,
    queue: complete && source.queue !== null ? queue : null,
    needsYou: queueRows
      .filter(
        (item) =>
          item.state === "proposed" ||
          item.state === "review" ||
          item.state === "halted",
      )
      .map(({ beadId, title, state }) => ({ beadId, title, state })),
    sessions,
    runs: (source.runs ?? []).filter(
      (run) =>
        run.epic !== null &&
        ids.has(run.epic) &&
        (run.checkout === null ||
          (source.checkout !== undefined &&
            workspaceKey(run.checkout) === workspaceKey(source.checkout))),
    ),
    sessionsComplete: complete && source.sessionsComplete,
    lastActivity: times[0] ?? null,
  };
}
