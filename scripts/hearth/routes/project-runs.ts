import { createHash } from "node:crypto";
import { LOG_BASE_DIR } from "../../../.claude/hooks/utils/constants";
import { checkpointsForEpic } from "../../../docs/js/forge-checkpoints";
import type {
  ProjectRunArtifact,
  ProjectRunDetail,
  ProjectRunGate,
  ProjectRunRow,
  ProjectRunsPage,
} from "../../../types/project-runs";
import type { ProjectRecord, ProjectWorkspace } from "../../../types/projects";
import { boardRows, forgeRunSnapshot } from "../../dashboard/forge-run-model";
import {
  createRunInspectionReader,
  RunInspectionError,
  readInspectionGateLogs,
} from "../../forge/inspection-read";
import {
  artifactPath,
  type ForgePhase,
  type ForgeState,
} from "../../forge/phases";
import type { ProjectCheckpointReviewAuthorityRequest } from "../../forge/project-checkpoint-review-service";
import { comparableCheckout, isValidSlug } from "../../forge/runs";
import { hashText } from "../../hash-text";
import {
  projectRunArtifactSchema,
  projectRunDetailSchema,
  projectRunsPageSchema,
} from "../../projects/run-protocol";
import { selectProjectBeads, workspaceKey } from "../../projects/scope";
import {
  createProjectStore,
  isProjectId,
  ProjectStoreError,
} from "../../projects/store";
import type { ReadRoute, RouteReply } from "../api";
import { fail, noParameters, type ReadDeps } from "./operator-reads";
import type { ProjectSnapshot } from "./project-summaries";

export class RunReadError extends Error {
  constructor(
    readonly status: 404 | 409 | 503,
    message: string,
  ) {
    super(message);
  }
}

interface ResolvedProjectRun {
  snapshot: ProjectSnapshot;
  project: ProjectRecord;
  scope: ProjectWorkspace;
  catalogRevision: number;
  members: Set<string>;
  source: ReturnType<typeof createRunInspectionReader>;
  states: ForgeState[];
  checkouts: Set<string>;
  found: ForgeState | null;
}

/** Shared post-tracker project and run authority for detail reads and checkpoint writes. */
function projectRunAuthorityReader(
  deps: ReadDeps & { projectHome: string },
  load: () => Promise<ProjectSnapshot>,
) {
  const captured = (() => {
    try {
      return createRunInspectionReader(deps.root);
    } catch {
      return null;
    }
  })();

  async function resolveRun(
    projectId: string,
    slug?: string,
  ): Promise<ResolvedProjectRun> {
    const snapshot = await load();
    // Catalog membership can change while the tracker await is outstanding.
    const catalog = createProjectStore(deps.projectHome).read();
    const project = catalog.projects.find((row) => row.id === projectId);
    if (!project)
      throw new RunReadError(404, "This project is not in the hearth catalog.");
    const scope = project.workspaces.find(
      (row) => workspaceKey(row.root) === workspaceKey(deps.workspace),
    );
    if (
      !scope ||
      workspaceKey(snapshot.source.workspace) !== workspaceKey(deps.workspace)
    )
      throw new RunReadError(
        409,
        "This hearth does not serve this project's workspace.",
      );
    if (
      snapshot.source.issues === null ||
      scope.epicIds.some(
        (id) =>
          !snapshot.source.issues?.some(
            (issue) => issue.id === id && issue.type === "epic",
          ),
      )
    )
      throw new RunReadError(
        503,
        "Project membership is unavailable or incomplete. Refresh Runs after the tracker can be read.",
      );
    const members = new Set(
      selectProjectBeads(project, deps.workspace, snapshot.source.issues).map(
        (row) => row.id,
      ),
    );
    const source = captured;
    if (!source)
      throw new RunReadError(
        503,
        "The served checkout's run source identity could not be verified.",
      );
    // Both addresses are server-owned spellings of the served checkout.
    // A linked worktree's ledger workspace belongs to its main checkout, not here.
    const checkouts = new Set(
      [source.checkout, deps.root].map(comparableCheckout),
    );
    const states = source
      .read()
      .filter(
        (state) =>
          state.epic &&
          members.has(state.epic) &&
          (!state.beadId || members.has(state.beadId)) &&
          (!state.checkout ||
            checkouts.has(comparableCheckout(state.checkout))),
      );
    const found = slug
      ? (states.find((state) => state.slug === slug) ?? null)
      : null;
    if (slug && !found)
      throw new RunReadError(
        404,
        "This run is not in the current project's served checkout.",
      );
    return {
      snapshot,
      project,
      scope,
      catalogRevision: catalog.revision,
      members,
      source,
      states,
      checkouts,
      found,
    };
  }

  async function checkpointBinding(
    request: ProjectCheckpointReviewAuthorityRequest,
  ) {
    const current = await resolveRun(request.projectId, request.runSlug);
    const run = current.found;
    if (current.project.archived)
      throw new RunReadError(
        409,
        "This project is archived. New checkpoint reviews are unavailable.",
      );
    if (!run?.epic)
      throw new RunReadError(
        409,
        "The selected run has no current project epic authority.",
      );
    if (
      current.snapshot.source.issues === null ||
      !current.snapshot.source.dependencies ||
      current.snapshot.source.problems.length > 0
    )
      throw new RunReadError(
        503,
        "Project membership or dependencies are unavailable or incomplete.",
      );
    if (
      run.updatedAt !== request.expectedRunUpdatedAt ||
      run.epic !== request.expectedEpicId
    )
      throw new RunReadError(
        409,
        "The live run changed. Refresh before recording a checkpoint review.",
      );
    const epic = current.snapshot.source.issues?.find(
      (issue) => issue.id === run.epic,
    );
    if (!epic || epic.type !== "epic" || !current.members.has(epic.id))
      throw new RunReadError(
        409,
        "The run's recorded epic is no longer in the current project scope.",
      );
    const issues = selectProjectBeads(
      current.project,
      deps.workspace,
      current.snapshot.source.issues ?? [],
    );
    const checkpoints = checkpointsForEpic(
      {
        issues: issues.map((issue) => ({
          id: issue.id,
          title: issue.title,
          status: issue.status,
          ...(issue.parent !== undefined ? { parent: issue.parent } : {}),
        })),
        deps: current.snapshot.source.dependencies ?? [],
      },
      run.epic,
    );
    const checkpoint = checkpoints.checkpoints.find(
      (item) => item.id === request.beadId,
    );
    if (!checkpoint || !checkpoints.inProgressIds.includes(request.beadId))
      throw new RunReadError(
        409,
        "Only a current in-progress leaf checkpoint can be reviewed.",
      );
    const bead = current.snapshot.source.issues?.find(
      (issue) => issue.id === request.beadId,
    );
    if (!bead || !current.members.has(bead.id))
      throw new RunReadError(
        409,
        "The checkpoint is no longer in the current project scope.",
      );
    const scopeHash = hashText(
      JSON.stringify({
        projectId: current.project.id,
        projectSlug: current.project.slug,
        workspace: current.scope,
        catalogRevision: current.catalogRevision,
        checkout: current.source.checkout,
        run: {
          slug: run.slug,
          epic: run.epic,
          beadId: run.beadId ?? null,
          checkout: run.checkout ?? null,
          updatedAt: run.updatedAt,
        },
        checkpoints: checkpoints.checkpoints.map(
          ({ id, status, groupId, blockedBy }) => ({
            id,
            status,
            groupId,
            blockedBy,
          }),
        ),
        selected: {
          id: bead.id,
          type: bead.type,
          parent: bead.parent ?? null,
          status: bead.status,
        },
      }),
    );
    return {
      projectId: current.project.id,
      workspacePath: current.scope.root,
      checkout: current.source.checkout,
      runSlug: run.slug,
      epicId: run.epic,
      beadId: bead.id,
      runUpdatedAt: run.updatedAt,
      catalogRevision: current.catalogRevision,
      scopeHash,
    };
  }

  function checkpointReadScope(
    projectId: string,
    runSlug: string,
    beadId: string,
  ) {
    const project = createProjectStore(deps.projectHome)
      .read()
      .projects.find((row) => row.id === projectId);
    if (!project)
      throw new RunReadError(404, "This project is not in the hearth catalog.");
    const scope = project.workspaces.find(
      (row) => workspaceKey(row.root) === workspaceKey(deps.workspace),
    );
    if (!scope)
      throw new RunReadError(
        409,
        "This hearth does not serve this project's workspace.",
      );
    return {
      projectId,
      workspacePath: scope.root,
      runSlug,
      beadId,
    };
  }

  return {
    resolveRun,
    checkpointBinding,
    checkpointReadScope,
    source: captured,
  };
}

/** A finite scan of the existing append-only log; partial/future entries cannot become gate facts. */
function scopedGateLogs(
  logs: readonly string[],
  members: ReadonlySet<string>,
  checkouts: ReadonlySet<string>,
  checkout: string,
) {
  let lines = 0,
    omitted = false;
  const checked = logs.map((log) => {
    const kept: string[] = [];
    for (let start = 0; start < log.length; ) {
      const newline = log.indexOf("\n", start);
      const end = newline < 0 ? log.length : newline;
      const line = log.slice(start, end).trim();
      start = end + 1;
      if (!line) continue;
      if (++lines > 20_000 || Buffer.byteLength(line) > 256 * 1024)
        throw new RunInspectionError();
      try {
        const row: unknown = JSON.parse(line);
        if (
          typeof row !== "object" ||
          row === null ||
          Array.isArray(row) ||
          !("passed" in row) ||
          typeof row.passed !== "boolean" ||
          !("checks" in row) ||
          !Array.isArray(row.checks) ||
          row.checks.length > 64 ||
          row.checks.some(
            (entry: unknown) =>
              typeof entry !== "object" ||
              entry === null ||
              !("name" in entry) ||
              typeof entry.name !== "string" ||
              !entry.name ||
              entry.name.length > 200 ||
              !("passed" in entry) ||
              typeof entry.passed !== "boolean",
          ) ||
          ("schemaVersion" in row && row.schemaVersion !== 2)
        ) {
          omitted = true;
          continue;
        }
        if (
          "schemaVersion" in row &&
          row.schemaVersion === 2 &&
          "beadsIssueId" in row &&
          typeof row.beadsIssueId === "string" &&
          !members.has(row.beadsIssueId)
        )
          continue;
        if (
          "checkout" in row &&
          typeof row.checkout === "string" &&
          checkouts.has(comparableCheckout(row.checkout))
        )
          row.checkout = checkout;
        kept.push(JSON.stringify(row));
      } catch (error) {
        if (error instanceof RunInspectionError) throw error;
        omitted = true;
      }
    }
    return kept.join("\n");
  });
  return {
    logs: checked,
    problems: omitted
      ? [
          "Incomplete, malformed or unsupported gate entries were omitted. Missing results are not proof that no check ran.",
        ]
      : [],
  };
}

/** Protected inspection only: no phase writer, provider or private session import. */
export function createProjectRunRoutes(
  deps: ReadDeps & { projectHome: string },
  load: () => Promise<ProjectSnapshot>,
) {
  const authority = projectRunAuthorityReader(deps, load);
  const captured = authority.source;
  async function read(projectId: string, slug?: string) {
    const { snapshot, source, members, checkouts, states, found } =
      await authority.resolveRun(projectId, slug);
    const gates = scopedGateLogs(
      states.length
        ? readInspectionGateLogs(deps.forgeGateLogRoot ?? LOG_BASE_DIR)
        : [],
      members,
      checkouts,
      source.checkout,
    );
    const view = forgeRunSnapshot({
      runStates: states.map((state) => JSON.stringify(state)),
      checkout: source.checkout,
      gateLogs: gates.logs,
      artifactExists: source.artifactExists,
    });
    const rows: ProjectRunRow[] = boardRows(view.runs).map((row) => ({
      ...row,
      complete:
        view.runs.find((item) => item.slug === row.slug)?.complete ?? false,
    }));
    const common = {
      version: 1 as const,
      projectId,
      workspace: deps.workspace,
      checkout: source.checkout,
      asOf: new Date().toISOString(),
      coverage: "served-checkout-only" as const,
      problems: gates.problems,
    };
    if (slug) {
      const row = rows.find((item) => item.slug === slug);
      if (!row || !found)
        throw new RunReadError(404, "This run is unavailable.");
      const selected = view.runs.find((item) => item.slug === slug);
      const gateHistory: ProjectRunGate[] = [
        selected?.gate,
        ...(selected?.earlierGates ?? []),
      ].flatMap((gate) =>
        gate
          ? [
              {
                event: gate.event,
                timestamp: gate.timestamp,
                passed: gate.passed,
                checks: gate.checks,
                checkout: gate.checkout,
                branch: gate.branch,
                link: gate.link,
                beadsIssueId: gate.beadsIssueId,
                executionRunId: gate.executionRunId,
                forgeSlug: gate.forgeSlug,
                evaluatorEvidence: gate.evaluatorVerdict?.evidence ?? null,
              },
            ]
          : [],
      );
      return projectRunDetailSchema.parse({
        ...common,
        run: row,
        reviews: (found.reviews ?? []).map(
          ({ phase, round, verdict, findings, summary, at }) => ({
            phase,
            round,
            verdict,
            findings,
            summary: summary ?? null,
            at,
          }),
        ),
        gateHistory,
        gateHistoryDays: 30,
        earlierGateLimit: 10,
      } satisfies ProjectRunDetail);
    }
    return projectRunsPageSchema.parse({
      ...common,
      runs: rows,
    } satisfies ProjectRunsPage);
  }
  async function readArtifact(
    projectId: string,
    slug: string,
    kind: Exclude<ForgePhase, "implement">,
  ): Promise<ProjectRunArtifact> {
    const snapshot = await load();
    const project = createProjectStore(deps.projectHome)
      .read()
      .projects.find((row) => row.id === projectId);
    if (!project)
      throw new RunReadError(404, "This project is not in the hearth catalog.");
    const scope = project.workspaces.find(
      (row) => workspaceKey(row.root) === workspaceKey(deps.workspace),
    );
    if (
      !scope ||
      workspaceKey(snapshot.source.workspace) !== workspaceKey(deps.workspace)
    )
      throw new RunReadError(
        409,
        "This hearth does not serve this project's workspace.",
      );
    if (
      snapshot.source.issues === null ||
      scope.epicIds.some(
        (id) =>
          !snapshot.source.issues?.some(
            (issue) => issue.id === id && issue.type === "epic",
          ),
      )
    )
      throw new RunReadError(
        503,
        "Project membership is unavailable or incomplete. Refresh Runs after the tracker can be read.",
      );
    const members = new Set(
      selectProjectBeads(project, deps.workspace, snapshot.source.issues).map(
        (row) => row.id,
      ),
    );
    const source = captured;
    if (!source)
      throw new RunReadError(503, "The served checkout could not be verified.");
    const checkouts = new Set(
      [source.checkout, deps.root].map(comparableCheckout),
    );
    const found = source
      .read()
      .find(
        (state) =>
          state.slug === slug &&
          !!state.epic &&
          members.has(state.epic) &&
          (!state.beadId || members.has(state.beadId)) &&
          (!state.checkout ||
            checkouts.has(comparableCheckout(state.checkout))),
      );
    const expected = artifactPath(kind, slug);
    if (
      !found ||
      !expected ||
      !found.completed.includes(kind) ||
      found.artifacts[kind] !== expected
    )
      throw new RunReadError(404, "This completed artifact is unavailable.");
    const document = source.readArtifact(kind, slug);
    if (!document)
      throw new RunReadError(404, "The recorded artifact file is unavailable.");
    // Recheck mutable authority and run binding after the file read.
    const latest = createProjectStore(deps.projectHome)
      .read()
      .projects.find((row) => row.id === projectId);
    const latestScope = latest?.workspaces.find(
      (row) => workspaceKey(row.root) === workspaceKey(deps.workspace),
    );
    const currentRun = source.read().find((state) => state.slug === slug);
    if (
      !latestScope ||
      latestScope.epicIds.join("\u0000") !== scope.epicIds.join("\u0000") ||
      !currentRun ||
      !currentRun.completed.includes(kind) ||
      currentRun.artifacts[kind] !== expected ||
      !currentRun.epic ||
      !members.has(currentRun.epic) ||
      (currentRun.beadId && !members.has(currentRun.beadId)) ||
      (currentRun.checkout &&
        !checkouts.has(comparableCheckout(currentRun.checkout)))
    )
      throw new RunReadError(
        409,
        "The project or recorded artifact changed during this read.",
      );
    return projectRunArtifactSchema.parse({
      version: 1,
      projectId,
      workspace: deps.workspace,
      checkout: source.checkout,
      asOf: new Date().toISOString(),
      coverage: "served-checkout-only",
      problems: [],
      slug,
      kind,
      artifact: document.artifact,
      bytes: document.bytes,
      sha256: createHash("sha256")
        .update(document.content, "utf8")
        .digest("hex"),
      content: document.content,
    });
  }
  async function answer(work: () => Promise<unknown>): Promise<RouteReply> {
    try {
      return { status: 200, data: await work() };
    } catch (error) {
      if (error instanceof RunReadError || error instanceof ProjectStoreError)
        return { status: error.status, error: error.message };
      return {
        status: 503,
        error:
          error instanceof RunInspectionError
            ? error.message
            : "Runs could not be read. Refresh to check their current source.",
      };
    }
  }
  const list: ReadRoute<{ projectId: string }> = {
    kind: "read",
    operatorOnly: true,
    method: "GET",
    path: "/projects/:id/runs",
    validate(request) {
      const params = noParameters(request);
      const projectId = request.params["id"];
      return !params.ok
        ? params
        : !isProjectId(projectId)
          ? fail("Expected a project id.")
          : { ok: true, value: { projectId } };
    },
    read: ({ projectId }) => answer(() => read(projectId)),
  };
  const detail: ReadRoute<{ projectId: string; slug: string }> = {
    kind: "read",
    operatorOnly: true,
    method: "GET",
    path: "/projects/:id/runs/:slug",
    validate(request) {
      const params = noParameters(request);
      const projectId = request.params["id"],
        slug = request.params["slug"];
      return !params.ok
        ? params
        : !isProjectId(projectId) || !slug || !isValidSlug(slug)
          ? fail("Expected a project id and exact run slug.")
          : { ok: true, value: { projectId, slug } };
    },
    read: ({ projectId, slug }) => answer(() => read(projectId, slug)),
  };
  const artifact: ReadRoute<{
    projectId: string;
    slug: string;
    kind: Exclude<ForgePhase, "implement">;
  }> = {
    kind: "read",
    operatorOnly: true,
    method: "GET",
    path: "/projects/:id/runs/:slug/artifacts/:kind",
    validate(request) {
      const params = noParameters(request);
      const projectId = request.params["id"],
        slug = request.params["slug"],
        kind = request.params["kind"];
      return !params.ok
        ? params
        : !isProjectId(projectId) || !slug || !isValidSlug(slug)
          ? fail("Expected a project id and exact run slug.")
          : kind !== "research" && kind !== "plan" && kind !== "ship"
            ? fail("Expected a completed research, plan or ship artifact.")
            : { ok: true, value: { projectId, slug, kind } };
    },
    read: ({ projectId, slug, kind }) =>
      answer(() => readArtifact(projectId, slug, kind)),
  };
  return {
    list,
    detail,
    artifact,
    checkpointAuthority: authority.checkpointBinding,
    checkpointReadScope: authority.checkpointReadScope,
  };
}
