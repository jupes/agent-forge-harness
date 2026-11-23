import type { SessionWorktreeRequest } from "../../../types/session-worktrees";
import { ConversationError } from "../../conversations/error";
import { isProjectId, ProjectStoreError } from "../../projects/store";
import { sessionWorktreeRequestSchema } from "../../sessions/worktree-protocol";
import { createSessionWorktreeService } from "../../sessions/worktrees";
import type { ActionRoute, ReadRoute, RouteReply, RouteRequest } from "../api";
import type { ValidationResult } from "../validate";
import { fail, noParameters, type ReadDeps } from "./operator-reads";
import type { ProjectSnapshot } from "./project-summaries";
import { createSessionRepositoryScopeValidator } from "./session-scope";

async function answer(work: () => Promise<unknown>): Promise<RouteReply> {
  try {
    return { status: 200, data: await work() };
  } catch (error) {
    if (
      error instanceof ConversationError ||
      error instanceof ProjectStoreError
    )
      return { status: error.status, error: error.message };
    throw error;
  }
}

/** Both rows use the common operator runner; creation remains separate from Start. */
export function createSessionWorktreeRoutes(
  home: string,
  deps: ReadDeps,
  load: () => Promise<ProjectSnapshot>,
) {
  const validate = createSessionRepositoryScopeValidator(deps, load);
  const service = createSessionWorktreeService({
    home,
    root: deps.root,
    git: deps.git,
    validateScope: (projectId, request) =>
      validate(projectId, {
        workspace: deps.workspace,
        repository: request.repository,
        beadId: request.beadId,
      }),
  });
  const project = (request: RouteRequest): ValidationResult<string> => {
    const id = request.params["id"];
    return isProjectId(id)
      ? { ok: true, value: id }
      : fail("Expected a project id.");
  };
  const create: ActionRoute<{
    projectId: string;
    input: SessionWorktreeRequest;
  }> = {
    kind: "action",
    method: "POST",
    path: "/projects/:id/session-worktrees",
    action: "session.worktree.create",
    maxBodyBytes: 8192,
    validate: (request) => {
      const selected = project(request),
        query = noParameters(request);
      if (!selected.ok) return selected;
      if (!query.ok) return query;
      const parsed = sessionWorktreeRequestSchema.safeParse(request.body);
      return parsed.success
        ? { ok: true, value: { projectId: selected.value, input: parsed.data } }
        : fail(
            "Expected an original worktree UUID, repository, base ref and safe new branch.",
          );
    },
    subject: ({ projectId, input }) => ({
      target: projectId,
      ...(input.beadId ? { beadId: input.beadId } : {}),
    }),
    effect: ({ projectId, input }) =>
      answer(() => service.create(projectId, input)),
  };
  const read: ReadRoute<{ projectId: string; requestId: string }> = {
    kind: "read",
    method: "GET",
    path: "/projects/:id/session-worktrees/:requestId",
    operatorOnly: true,
    validate: (request) => {
      const selected = project(request),
        query = noParameters(request);
      if (!selected.ok) return selected;
      if (!query.ok) return query;
      const id = request.params["requestId"];
      const parsed = sessionWorktreeRequestSchema.shape.requestId.safeParse(id);
      return parsed.success
        ? {
            ok: true,
            value: { projectId: selected.value, requestId: parsed.data },
          }
        : fail("Expected the original worktree request UUID.");
    },
    read: ({ projectId, requestId }) =>
      answer(() => service.read(projectId, requestId)),
  };
  return { create, read };
}
