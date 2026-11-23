import type { ProjectsHome } from "../../../types/project-summary";
import type { ProjectCatalog } from "../../../types/projects";
import { issuesAndDepsFromExportRows } from "../../beads-dashboard";
import { listRuns } from "../../forge/runs-store";
import { listSessions } from "../../ledger/query";
import { workspaceKey } from "../../projects/scope";
import { createProjectStore, ProjectStoreError } from "../../projects/store";
import { type ProjectSources, summarizeProject } from "../../projects/summary";
import { createSessionRegistry } from "../../sessions/registry";
import { type ReadRoute, safeMessage } from "../api";
import {
  coalesced,
  hearthLedger,
  noParameters,
  queueEntries,
  type ReadDeps,
  withTimeout,
} from "./operator-reads";

export interface ProjectSnapshot {
  catalog: ProjectCatalog;
  source: ProjectSources;
}

/** Shared by home and project views; no stored project path is used for I/O. */
export function projectSnapshotReader(
  home: string,
  deps: ReadDeps,
  options: {
    membershipOnly?: true;
    includeEmpty?: true;
    omitRuns?: true;
    now?: () => Date;
  } = {},
): () => Promise<ProjectSnapshot> {
  const readTracker = coalesced(async () => {
    if (!deps.completeTracker)
      throw Error("Complete tracker source unavailable.");
    return withTimeout(
      deps.completeTracker(),
      Math.min(7000, (deps.bdTimeoutMs ?? 6000) + 1000),
      "Complete tracker source unavailable.",
    );
  });
  return async () => {
    const catalog = createProjectStore(home).read();
    const source: ProjectSources = {
      workspace: deps.workspace,
      asOf: (options.now?.() ?? new Date()).toISOString(),
      issues: null,
      queue: null,
      sessions: [],
      sessionsComplete: false,
      problems: [],
      checkout: deps.root,
    };
    if (catalog.projects.length || options.includeEmpty) {
      // listRuns is the existing checkout-bound producer. Its empty result
      // is not a claim that all workspace worktrees were searched.
      if (!options.membershipOnly && !options.omitRuns)
        source.runs = listRuns(deps.root);
      try {
        const { rows: issues } = await readTracker();
        const normalized = issuesAndDepsFromExportRows(issues);
        source.issues = normalized.issues;
        source.dependencies = normalized.deps;
        const queue = queueEntries(JSON.stringify(issues));
        if (!queue.ok) throw new Error("Queue unavailable");
        source.queue = queue.entries;
        source.beadRows = issues;
      } catch (error) {
        source.issues = null;
        source.queue = null;
        source.problems.push(
          `Tracker read unavailable or incomplete: ${safeMessage(error)}. Refresh to check again.`,
        );
      }
      if (options.membershipOnly) return { catalog, source };
      try {
        source.sessions = listSessions(
          { workspace: deps.workspace, limit: 500 },
          hearthLedger(deps.ledgerPath),
        );
        source.sessionsComplete = source.sessions.length < 500;
      } catch {
        source.problems.push("Session observations are unavailable.");
      }
      try {
        const registry = createSessionRegistry(home);
        source.ownedSessions = catalog.projects
          .flatMap((project) => registry.listAll(project.id))
          .filter(
            (session) =>
              workspaceKey(session.workspace) === workspaceKey(deps.workspace),
          );
      } catch {
        source.sessionsComplete = false;
        source.problems.push(
          "Private owned-session membership is unavailable; unbound sessions are not included.",
        );
      }
    }
    return { catalog, source };
  };
}

export function projectSummaryRoute(
  home: string,
  deps: ReadDeps,
  load = projectSnapshotReader(home, deps),
): ReadRoute<null> {
  return {
    kind: "read",
    method: "GET",
    path: "/projects/summary",
    validate: noParameters,
    read: async () => {
      let snapshot: ProjectSnapshot;
      try {
        snapshot = await load();
      } catch (error) {
        if (error instanceof ProjectStoreError)
          return { status: error.status, error: error.message };
        throw error;
      }
      const { catalog, source } = snapshot;
      const data: ProjectsHome = {
        catalog: {
          version: catalog.version,
          revision: catalog.revision,
          projects: catalog.projects,
        },
        asOf: source.asOf,
        summaries: catalog.projects.map((project) =>
          summarizeProject(project, source),
        ),
      };
      return { status: 200, data };
    },
  };
}
