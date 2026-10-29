import { z } from "zod";
import {
  PROJECT_CHECKPOINT_REVIEW_MAX_BODY_BYTES,
  type ProjectCheckpointReviewScope,
  projectCheckpointReviewHashRequestSchema,
  projectCheckpointReviewPrepareRequestSchema,
} from "../../../types/project-checkpoint-reviews";
import { ConversationError } from "../../conversations/error";
import {
  createProjectCheckpointReviewService,
  type ProjectCheckpointReviewAuthorityResolver,
} from "../../forge/project-checkpoint-review-service";
import {
  createProjectCheckpointReviewStore,
  type ProjectCheckpointReviewQueueLock,
} from "../../forge/project-checkpoint-review-store";
import { isValidSlug } from "../../forge/runs";
import { isProjectId, ProjectStoreError } from "../../projects/store";
import type { ActionRoute, ApiRoute, ReadRoute, RouteReply } from "../api";
import { isBeadId } from "../tracker-write";
import { fail, type ReadDeps } from "./operator-reads";
import { RunReadError } from "./project-runs";

const MAX_SHOW_BYTES = 1024 * 1024;
const showCountRow = z
  .object({
    id: z.string().min(1).max(200),
    comment_count: z.number().int().nonnegative(),
  })
  .passthrough();

function errorReply(error: unknown): RouteReply {
  if (
    error instanceof ConversationError ||
    error instanceof RunReadError ||
    error instanceof ProjectStoreError
  )
    return { status: error.status, error: error.message };
  return {
    status: 503,
    error:
      "The checkpoint review could not be verified. Refresh and read the saved record before trying again.",
  };
}

async function answer(
  work: () => unknown | Promise<unknown>,
): Promise<RouteReply> {
  try {
    return { status: 200, data: await work() };
  } catch (error) {
    return errorReply(error);
  }
}

export function createProjectCheckpointReviewRoutes(options: {
  home: string;
  workspace: string;
  appendEvent: ReadDeps["appendEvent"];
  queueLock: ProjectCheckpointReviewQueueLock;
  runBd: ReadDeps["runBd"];
  bdTimeoutMs?: number | undefined;
  resolveAuthority: ProjectCheckpointReviewAuthorityResolver;
  readScope(
    projectId: string,
    runSlug: string,
    beadId: string,
  ): ProjectCheckpointReviewScope;
}) {
  const store = createProjectCheckpointReviewStore({
    home: options.home,
    withQueueLock: options.queueLock,
  });
  const service = createProjectCheckpointReviewService({
    store,
    resolveAuthority: options.resolveAuthority,
    ...(options.bdTimeoutMs !== undefined
      ? { bdTimeoutMs: options.bdTimeoutMs }
      : {}),
    runBd: options.runBd,
    workspace: options.workspace,
    appendEvent: options.appendEvent,
    readCommentCount: async (_projectId, beadId) => {
      const answer = await options.runBd(
        ["--readonly", "show", beadId, "--json"],
        { timeoutMs: options.bdTimeoutMs ?? 15_000 },
      );
      if (
        answer.status !== 0 ||
        Buffer.byteLength(answer.stdout, "utf8") > MAX_SHOW_BYTES
      )
        return null;
      let raw: unknown;
      try {
        raw = JSON.parse(answer.stdout);
      } catch {
        return null;
      }
      const rows = Array.isArray(raw) ? raw : [raw];
      if (rows.length !== 1) return null;
      const row = showCountRow.safeParse(rows[0]);
      return row.success && row.data.id === beadId
        ? row.data.comment_count
        : null;
    },
  });

  const location = (request: Parameters<ReadRoute["validate"]>[0]) => {
    const { params } = request;
    if ([...request.query.keys()].length)
      return fail("Checkpoint review routes take no query parameters.");
    const projectId = params["id"],
      runSlug = params["slug"],
      beadId = params["beadId"];
    if (
      !isProjectId(projectId) ||
      !runSlug ||
      !isValidSlug(runSlug) ||
      !isBeadId(beadId)
    )
      return fail("Expected a project, exact Run slug, and bead id.");
    return { ok: true as const, value: { projectId, runSlug, beadId } };
  };
  const scopeFor = (projectId: string, runSlug: string, beadId: string) =>
    options.readScope(projectId, runSlug, beadId);
  async function readInCurrentScope<T>(
    scope: ProjectCheckpointReviewScope,
    work: (scope: ProjectCheckpointReviewScope) => Promise<T>,
  ): Promise<T> {
    const result = await work(scope);
    const current = scopeFor(scope.projectId, scope.runSlug, scope.beadId);
    if (
      current.projectId !== scope.projectId ||
      current.workspacePath !== scope.workspacePath ||
      current.runSlug !== scope.runSlug ||
      current.beadId !== scope.beadId
    )
      throw new ConversationError(
        409,
        "The project workspace changed while checkpoint review data was being read. Refresh and try again.",
      );
    return result;
  }
  const metadata: ReadRoute<{
    projectId: string;
    runSlug: string;
    beadId: string;
  }> = {
    kind: "read",
    method: "GET",
    operatorOnly: true,
    path: "/projects/:id/runs/:slug/checkpoints/:beadId/reviews",
    validate: location,
    read: ({ projectId, runSlug, beadId }) =>
      answer(() =>
        readInCurrentScope(
          scopeFor(projectId, runSlug, beadId),
          (scope) => service.metadata(scope),
        ),
      ),
  };
  const original: ReadRoute<{
    projectId: string;
    runSlug: string;
    beadId: string;
    requestId: string;
  }> = {
    kind: "read",
    method: "GET",
    operatorOnly: true,
    path: "/projects/:id/runs/:slug/checkpoints/:beadId/reviews/:requestId",
    validate(request) {
      const checked = location(request);
      if (!checked.ok) return checked;
      const requestId = z
        .uuid()
        .refine((value) => value === value.toLowerCase())
        .safeParse(request.params["requestId"]);
      return requestId.success
        ? { ok: true, value: { ...checked.value, requestId: requestId.data } }
        : fail("Expected a checkpoint review request UUID.");
    },
    read: ({ projectId, runSlug, beadId, requestId }) =>
      answer(async () => {
        const saved = await readInCurrentScope(
          scopeFor(projectId, runSlug, beadId),
          (scope) => service.original(scope, requestId),
        );
        if (!saved)
          throw new ConversationError(
            404,
            "This checkpoint review original is not retained.",
          );
        return saved;
      }),
  };
  const prepare: ActionRoute<{
    projectId: string;
    runSlug: string;
    beadId: string;
    request: z.infer<typeof projectCheckpointReviewPrepareRequestSchema>;
  }> = {
    kind: "action",
    method: "POST",
    operatorOnly: true,
    path: "/projects/:id/runs/:slug/checkpoints/:beadId/reviews",
    action: "checkpoint.review.prepare",
    maxBodyBytes: PROJECT_CHECKPOINT_REVIEW_MAX_BODY_BYTES,
    validate(request) {
      const checked = location(request);
      if (!checked.ok) return checked;
      const parsed = projectCheckpointReviewPrepareRequestSchema.safeParse(
        request.body,
      );
      return parsed.success
        ? { ok: true, value: { ...checked.value, request: parsed.data } }
        : fail("The checkpoint review request is invalid.");
    },
    subject: ({ beadId, request }) => ({
      target: beadId,
      beadId,
      requestId: request.requestId,
    }),
    effect: ({ projectId, runSlug, beadId, request }, context) =>
      context
        ? answer(() =>
            service.prepare(
              { projectId, runSlug, beadId, request },
              context.auditEventId,
            ),
          )
        : Promise.resolve({
            status: 503,
            error: "The checkpoint review action was not audited.",
          }),
  };
  const action = (
    suffix: "commit" | "retire" | "readback",
    actionName: string,
  ): ActionRoute<{
    projectId: string;
    runSlug: string;
    beadId: string;
    requestId: string;
    intentHash: string;
  }> => ({
    kind: "action",
    method: "POST",
    operatorOnly: true,
    path: `/projects/:id/runs/:slug/checkpoints/:beadId/reviews/:requestId/${suffix}`,
    action: actionName,
    maxBodyBytes: PROJECT_CHECKPOINT_REVIEW_MAX_BODY_BYTES,
    validate(request) {
      const checked = location(request);
      if (!checked.ok) return checked;
      const requestId = z
        .uuid()
        .refine((value) => value === value.toLowerCase())
        .safeParse(request.params["requestId"]);
      if (!requestId.success)
        return fail("Expected a checkpoint review request UUID.");
      const body = projectCheckpointReviewHashRequestSchema.safeParse(
        request.body,
      );
      return body.success
        ? {
            ok: true,
            value: {
              ...checked.value,
              requestId: requestId.data,
              intentHash: body.data.intentHash,
            },
          }
        : fail("Expected the saved checkpoint review hash.");
    },
    subject: ({ beadId, requestId, intentHash }) => ({
      target: beadId,
      beadId,
      requestId,
      inputHash: intentHash,
    }),
    effect: (input, context) => {
      if (!context)
        return {
          status: 503,
          error: "The checkpoint review action was not audited.",
        };
      return answer(async () => {
        const scope = scopeFor(input.projectId, input.runSlug, input.beadId);
        if (suffix === "commit")
          return service.commit(
            {
              ...scope,
              requestId: input.requestId,
              intentHash: input.intentHash,
            },
            context.auditEventId,
          );
        if (suffix === "retire")
          return service.retire(
            scope,
            input.requestId,
            input.intentHash,
            context.auditEventId,
          );
        return service.readback(
          scope,
          input.requestId,
          input.intentHash,
          context.auditEventId,
        );
      });
    },
  });
  const commit = action("commit", "checkpoint.review.commit");
  const retire = action("retire", "checkpoint.review.retire");
  const readback = action("readback", "checkpoint.review.readback");
  const reads: ReadRoute[] = [metadata, original];
  const actions: ActionRoute[] = [prepare, commit, retire, readback];
  const routes: ApiRoute[] = [...reads, ...actions];
  return {
    reads,
    actions,
    routes,
    close: () => service.close(),
  };
}
