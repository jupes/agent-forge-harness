import type { ProjectsHome } from "../../../types/project-summary";
import type { ProjectCatalog } from "../../../types/projects";
import {
  issueRowsOf,
  issuesAndDepsFromExportRows,
  parseBdExportStdout,
} from "../../beads-dashboard";
import { listRuns } from "../../forge/runs-store";
import { listSessions } from "../../ledger/query";
import { workspaceKey } from "../../projects/scope";
import { createProjectStore, ProjectStoreError } from "../../projects/store";
import { type ProjectSources, summarizeProject } from "../../projects/summary";
import { createSessionRegistry } from "../../sessions/registry";
import { type ReadRoute, safeMessage } from "../api";
import {
  BEAD_COUNT_ARGS,
  coalesced,
  hearthLedger,
  isRecord,
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
  options: { membershipOnly?: true; includeEmpty?: true; omitRuns?: true } = {},
): () => Promise<ProjectSnapshot> {
  const readTracker = coalesced(async () => {
    const timeoutMs = deps.bdTimeoutMs ?? 15_000;
    return withTimeout(
      Promise.resolve(deps.runBd([...BEAD_COUNT_ARGS], { timeoutMs })),
      timeoutMs + 1000,
      "Project tracker read timed out.",
    );
  });
  return async () => {
    const catalog = createProjectStore(home).read();
    const source: ProjectSources = {
      workspace: deps.workspace,
      asOf: new Date().toISOString(),
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
        const result = await readTracker();
        if (result.status !== 0) throw new Error("Tracker unavailable");
        const lines = result.stdout.split("\n").filter((line) => line.trim());
        const rows = parseBdExportStdout(result.stdout);
        // The snapshot parser intentionally skips invalid lines. Totals cannot.
        if (rows.length !== lines.length) throw new Error("Partial export");
        if (
          rows.some(
            (row) =>
              !isRecord(row) ||
              (row._type !== undefined && typeof row._type !== "string"),
          )
        )
          throw new Error("Invalid export record");
        const issues = issueRowsOf(rows);
        if (
          rows.some(
            (row) =>
              (row._type === undefined || row._type === "issue") &&
              typeof row.id !== "string",
          )
        )
          throw new Error("Invalid issue identity");
        if (
          issues.some(
            (row) =>
              typeof row.title !== "string" ||
              typeof row.status !== "string" ||
              typeof row.issue_type !== "string" ||
              (row.labels !== undefined &&
                (!Array.isArray(row.labels) ||
                  row.labels.some((label) => typeof label !== "string"))) ||
              (row.dependencies !== undefined &&
                (!Array.isArray(row.dependencies) ||
                  row.dependencies.some(
                    (edge) =>
                      !isRecord(edge) ||
                      typeof edge.issue_id !== "string" ||
                      typeof edge.depends_on_id !== "string" ||
                      typeof edge.type !== "string",
                  ))),
          ) ||
          new Set(issues.map((row) => row.id)).size !== issues.length
        )
          throw new Error("Invalid issue export");
        const normalized = issuesAndDepsFromExportRows(
          issues.map((row) => ({
            ...row,
            created_at: row.created_at ?? row.createdAt ?? "",
            updated_at: row.updated_at ?? row.updatedAt ?? "",
          })),
        );
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
