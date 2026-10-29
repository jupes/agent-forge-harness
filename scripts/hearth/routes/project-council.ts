import { isDeepStrictEqual } from "node:util";
import type {
  ProjectCouncilAuthority,
  ProjectCouncilReserveRequest,
  ProjectCouncilSourceRef,
} from "../../../types/project-council";
import {
  projectCouncilHistorySchema,
  projectCouncilRequestIdSchema,
  projectCouncilReserveRequestSchema,
} from "../../../types/project-council";
import { ConversationError } from "../../conversations/error";
import { safeCouncilError } from "../../council/service";
import { hashText } from "../../hash-text";
import { selectProjectBeads, workspaceKey } from "../../projects/scope";
import {
  createProjectStore,
  isProjectId,
  ProjectStoreError,
} from "../../projects/store";
import type { ActionRoute, ApiRoute, ReadRoute, RouteReply } from "../api";
import type { ValidationResult } from "../validate";
import { postCouncilVerdict } from "./council-verdict";
import type { OperatorDeps } from "./operator";
import { fail } from "./operator-reads";
import type { ProjectSnapshot } from "./project-summaries";

type Council = OperatorDeps["council"];
type ProjectId = { projectId: string };
type ReviewRef = { projectId: string; requestId: string };
type ReviewAction = ReviewRef & { intentHash: string };

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function reply(work: () => unknown | Promise<unknown>): Promise<RouteReply> {
  return Promise.resolve()
    .then(work)
    .then((data) => ({ status: 200, data }))
    .catch((error: unknown) => {
      if (
        error instanceof ConversationError ||
        error instanceof ProjectStoreError
      )
        return { status: error.status, error: error.message };
      return {
        status: 503,
        error:
          "The original project Council request could not be verified. Read the original before trying again.",
      };
    });
}

/** Project authority is always re-read by this Hearth adapter, never from a renderer path. */
export function createProjectCouncilRoutes(
  deps: OperatorDeps & { projectHome: string },
  load: () => Promise<ProjectSnapshot>,
) {
  const currentProject = async (projectId: string, allowArchived: boolean) => {
    const snapshot = await load();
    const catalog = createProjectStore(deps.projectHome).read();
    const project = catalog.projects.find((item) => item.id === projectId);
    if (!project)
      throw new ConversationError(
        404,
        "This project is not in the Hearth catalog.",
      );
    if (!allowArchived && project.archived)
      throw new ConversationError(
        409,
        "This project is archived. Existing Council originals remain readable.",
      );
    if (
      workspaceKey(snapshot.source.workspace) !==
        workspaceKey(deps.workspace) ||
      !project.workspaces.some(
        (workspace) =>
          workspaceKey(workspace.root) === workspaceKey(deps.workspace),
      )
    )
      throw new ConversationError(
        409,
        "This Hearth does not serve the selected project workspace.",
      );
    return { project, catalog, snapshot };
  };

  const resolveAuthority = async (
    projectId: string,
    source: ProjectCouncilSourceRef,
  ): Promise<ProjectCouncilAuthority> => {
    const { project, catalog, snapshot } = await currentProject(
      projectId,
      false,
    );
    const scope = project.workspaces.find(
      (item) => workspaceKey(item.root) === workspaceKey(deps.workspace),
    );
    if (!scope)
      throw new ConversationError(
        409,
        "This Hearth does not serve the selected project workspace.",
      );
    let beadScope: unknown = null;
    if (source.sourceType === "bead") {
      if (!snapshot.source.issues)
        throw new ConversationError(
          503,
          "Current project membership is unavailable. Refresh before reviewing this bead.",
        );
      const member = selectProjectBeads(
        project,
        deps.workspace,
        snapshot.source.issues,
      ).find((issue) => issue.id === source.source);
      if (!member)
        throw new ConversationError(
          409,
          "This bead is not in the current project scope.",
        );
      beadScope = {
        id: member.id,
        type: member.type,
        parent: member.parent ?? null,
        labels: [...(member.labels ?? [])],
      };
    }
    const scopeHash = hashText(
      JSON.stringify({
        projectId: project.id,
        slug: project.slug,
        archived: project.archived,
        workspace: scope,
        beadScope,
        catalogRevision: catalog.revision,
      }),
    );
    return {
      projectId,
      workspace: deps.workspace,
      workspaceRoot: deps.root,
      catalogRevision: catalog.revision,
      scopeHash,
    };
  };

  const projectId = (
    request: Parameters<ReadRoute["validate"]>[0],
  ): ValidationResult<ProjectId> => {
    if ([...request.query.keys()].length)
      return fail(
        "Project Council reads and actions take no query parameters.",
      );
    const value = request.params["id"];
    return isProjectId(value)
      ? { ok: true, value: { projectId: value } }
      : fail("Expected a project id.");
  };

  const reviewRef = (
    request: Parameters<ReadRoute["validate"]>[0],
  ): ValidationResult<ReviewRef> => {
    const project = projectId(request);
    if (!project.ok) return project;
    const parsed = projectCouncilRequestIdSchema.safeParse(
      request.params["requestId"],
    );
    return parsed.success
      ? { ok: true, value: { ...project.value, requestId: parsed.data } }
      : fail("Expected a project Council original UUID.");
  };

  const actionRef = (
    request: Parameters<ActionRoute["validate"]>[0],
  ): ValidationResult<ReviewAction> => {
    const ref = reviewRef(request);
    if (!ref.ok) return ref;
    if (
      !record(request.body) ||
      Object.keys(request.body).length !== 1 ||
      typeof request.body["intentHash"] !== "string" ||
      !/^[a-f0-9]{64}$/.test(request.body["intentHash"])
    )
      return fail("Expected the exact reviewed Council intent hash.");
    return {
      ok: true,
      value: { ...ref.value, intentHash: request.body["intentHash"] },
    };
  };

  const discover: ReadRoute<ProjectId> = {
    kind: "read",
    method: "GET",
    path: "/projects/:id/council/reviews",
    operatorOnly: true,
    validate: projectId,
    read: ({ projectId }) =>
      reply(async () => {
        const { project } = await currentProject(projectId, true);
        if (
          !project.workspaces.some(
            (item) => workspaceKey(item.root) === workspaceKey(deps.workspace),
          )
        )
          throw new ConversationError(
            404,
            "This project has no original in this Hearth workspace.",
          );
        return projectCouncilHistorySchema.parse(
          deps.council.historyProjectReviews(projectId, deps.workspace),
        );
      }),
  };

  const original: ReadRoute<ReviewRef> = {
    kind: "read",
    method: "GET",
    path: "/projects/:id/council/reviews/:requestId",
    operatorOnly: true,
    validate: reviewRef,
    read: ({ projectId, requestId }) =>
      reply(async () => {
        const { project } = await currentProject(projectId, true);
        if (
          !project.workspaces.some(
            (item) => workspaceKey(item.root) === workspaceKey(deps.workspace),
          )
        )
          throw new ConversationError(
            404,
            "This project has no original in this Hearth workspace.",
          );
        return deps.council.readProjectOriginal(
          projectId,
          deps.workspace,
          requestId,
        );
      }),
  };

  const run: ReadRoute<ReviewRef> = {
    kind: "read",
    method: "GET",
    path: "/projects/:id/council/reviews/:requestId/run",
    operatorOnly: true,
    validate: reviewRef,
    read: ({ projectId, requestId }) =>
      reply(async () => {
        const { project } = await currentProject(projectId, true);
        if (
          !project.workspaces.some(
            (item) => workspaceKey(item.root) === workspaceKey(deps.workspace),
          )
        )
          throw new ConversationError(
            404,
            "This project has no original in this Hearth workspace.",
          );
        const original = deps.council.readProjectOriginal(
          projectId,
          deps.workspace,
          requestId,
        );
        return deps.council.readProjectRun(
          projectId,
          deps.workspace,
          requestId,
          original.metadata.intentHash,
        );
      }),
  };

  const reserve: ActionRoute<{
    projectId: string;
    request: ProjectCouncilReserveRequest;
  }> = {
    kind: "action",
    method: "POST",
    path: "/projects/:id/council/reviews",
    action: "council.review.reserve",
    maxBodyBytes: 2_097_152,
    validate(request) {
      const project = projectId(request);
      if (!project.ok) return project;
      const parsed = projectCouncilReserveRequestSchema.safeParse(request.body);
      return parsed.success
        ? { ok: true, value: { ...project.value, request: parsed.data } }
        : fail("Expected a strict project Council review choice.");
    },
    subject: ({ projectId }) => ({ target: projectId }),
    effect: async ({ projectId, request }) => {
      try {
        return {
          status: 202,
          data: await deps.council.reserveProjectReview(
            projectId,
            request,
            resolveAuthority,
          ),
        };
      } catch (error) {
        return {
          status: error instanceof ConversationError ? error.status : 409,
          error: safeCouncilError(error),
        };
      }
    },
  };

  const commit: ActionRoute<ReviewAction> = {
    kind: "action",
    method: "POST",
    path: "/projects/:id/council/reviews/:requestId/commit",
    action: "council.review.commit",
    validate: actionRef,
    subject: ({ requestId, intentHash }) => ({
      target: requestId,
      inputHash: intentHash,
    }),
    effect: async ({ projectId, requestId, intentHash }) => {
      try {
        const result = await deps.council.commitProjectReview(
          projectId,
          deps.workspace,
          requestId,
          intentHash,
          resolveAuthority,
        );
        const original = deps.council.readProjectOriginal(
          projectId,
          deps.workspace,
          requestId,
        );
        if (
          result.created &&
          original.original.context.source.kind === "bead"
        ) {
          const ownedRun = () =>
            deps.council.readProjectRun(
              projectId,
              deps.workspace,
              requestId,
              intentHash,
            );
          const verifiedCouncil: Council = {
            ...deps.council,
            wait: async (runId) => {
              if (runId !== original.original.runId)
                throw new Error("The Council verdict run identity changed.");
              const before = ownedRun();
              if (
                before.provenance.requestId !== requestId ||
                before.provenance.intentHash !== intentHash ||
                before.provenance.runId !== runId ||
                before.provenance.projectId !== projectId ||
                before.job?.runId !== runId
              )
                throw new Error(
                  "The Council verdict run is not owned by this original.",
                );
              const job = await deps.council.wait(runId);
              const after = ownedRun();
              const completedJob = after.job;
              if (
                after.receipt.phase !== "completed" ||
                after.provenance.requestId !== requestId ||
                after.provenance.intentHash !== intentHash ||
                after.provenance.runId !== runId ||
                after.provenance.projectId !== projectId ||
                !completedJob ||
                completedJob.runId !== runId ||
                completedJob.status !== job.status ||
                completedJob.status !== "completed" ||
                !completedJob.run ||
                !job.run ||
                !isDeepStrictEqual(completedJob.run, job.run) ||
                !isDeepStrictEqual(
                  completedJob.profile,
                  original.original.profile,
                ) ||
                !isDeepStrictEqual(job.profile, original.original.profile) ||
                !isDeepStrictEqual(
                  {
                    source: job.run.context.source,
                    contentHash: job.run.context.contentHash,
                    byteLength: job.run.context.byteLength,
                    truncated: job.run.context.truncated,
                    redactions: job.run.context.redactions,
                    evidence: job.run.context.evidence,
                  },
                  {
                    source: original.original.context.source,
                    contentHash: original.original.context.contentHash,
                    byteLength: original.original.context.byteLength,
                    truncated: original.original.context.truncated,
                    redactions: original.original.context.redactions,
                    evidence: original.original.context.evidence,
                  },
                )
              )
                throw new Error(
                  "The Council verdict did not match its reviewed original.",
                );
              return job;
            },
          };
          void postCouncilVerdict(
            {
              workspace: deps.workspace,
              runBd: deps.runBd,
              appendEvent: deps.appendEvent,
              council: verifiedCouncil,
            },
            {
              sourceType: "bead",
              beadId: original.original.context.source.locator,
            },
            original.original.runId,
          );
        }
        return { status: 202, data: result.receipt };
      } catch (error) {
        return {
          status: error instanceof ConversationError ? error.status : 409,
          error: safeCouncilError(error),
        };
      }
    },
  };

  const retire: ActionRoute<ReviewAction> = {
    kind: "action",
    method: "POST",
    path: "/projects/:id/council/reviews/:requestId/retire",
    action: "council.review.retire",
    validate: actionRef,
    subject: ({ requestId, intentHash }) => ({
      target: requestId,
      inputHash: intentHash,
    }),
    effect: async ({ projectId, requestId, intentHash }) =>
      reply(() =>
        deps.council.retireProjectReview(
          projectId,
          deps.workspace,
          requestId,
          intentHash,
        ),
      ),
  };

  const cancel: ActionRoute<ReviewAction> = {
    kind: "action",
    method: "POST",
    path: "/projects/:id/council/reviews/:requestId/cancel",
    action: "council.review.cancel",
    validate: actionRef,
    subject: ({ requestId, intentHash }) => ({
      target: requestId,
      inputHash: intentHash,
    }),
    effect: async ({ projectId, requestId, intentHash }) =>
      reply(() =>
        deps.council.cancelProjectReview(
          projectId,
          deps.workspace,
          requestId,
          intentHash,
        ),
      ),
  };

  return {
    routes: [
      discover,
      original,
      run,
      reserve,
      commit,
      retire,
      cancel,
    ] as ApiRoute[],
  };
}
