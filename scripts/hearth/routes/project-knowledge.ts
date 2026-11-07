import { z } from "zod";
import { ConversationError } from "../../conversations/error";
import {
  knowledgeReceiptSchema,
  knowledgeRefreshRequestSchema,
  knowledgeStatusSchema,
} from "../../projects/knowledge-protocol";
import type { createKnowledgeService } from "../../projects/knowledge-service";
import { knowledgeOperationHash } from "../../projects/knowledge-store";
import { isProjectId, ProjectStoreError } from "../../projects/store";
import type { ActionRoute, ReadRoute, RouteReply, RouteRequest } from "../api";
import type { ValidationResult } from "../validate";
import { fail } from "./operator-reads";

type Service = ReturnType<typeof createKnowledgeService>;
type Identity = { projectId: string; requestId: string };
const uuid = z.uuid().refine((value) => value === value.toLowerCase());
const identity = (request: RouteRequest): ValidationResult<Identity> => {
  const projectId = request.params.id,
    requestId = uuid.safeParse(request.params.requestId);
  return isProjectId(projectId) && requestId.success && request.query.size === 0
    ? { ok: true, value: { projectId, requestId: requestId.data } }
    : fail(
        "Expected a project and exact lowercase knowledge UUID with no query parameters.",
      );
};
async function reply(
  work: () => unknown | Promise<unknown>,
): Promise<RouteReply> {
  try {
    return { status: 200, data: await work() };
  } catch (error) {
    return error instanceof ConversationError ||
      error instanceof ProjectStoreError
      ? { status: error.status, error: error.message }
      : {
          status: 503,
          error:
            "Knowledge could not be verified. Check the saved original; no automatic generation or publication will be repeated.",
        };
  }
}
/** Origin/token/body/audit/envelope are owned solely by the common operator runner. */
export function createProjectKnowledgeRoutes(service: Service) {
  const base = "/projects/:id/settings/knowledge";
  const status: ReadRoute<{ projectId: string }> = {
    kind: "read",
    method: "GET",
    path: base,
    operatorOnly: true,
    validate: (request) =>
      isProjectId(request.params.id) && request.query.size === 0
        ? { ok: true, value: { projectId: request.params.id } }
        : fail("Expected a project id with no query parameters."),
    read: ({ projectId }) =>
      reply(() => knowledgeStatusSchema.parse(service.status(projectId))),
  };
  const receipt: ReadRoute<Identity> = {
    kind: "read",
    method: "GET",
    path: base + "/:requestId",
    operatorOnly: true,
    validate: identity,
    read: ({ projectId, requestId }) =>
      reply(() =>
        knowledgeReceiptSchema.parse(service.receipt(projectId, requestId)),
      ),
  };
  const refresh: ActionRoute<{
    projectId: string;
    request: z.infer<typeof knowledgeRefreshRequestSchema>;
  }> = {
    kind: "action",
    method: "POST",
    path: base,
    action: "project.knowledge.refresh",
    maxBodyBytes: 1024,
    rejectDuplicateBodyKeys: true,
    validate: (request) => {
      const parsed = knowledgeRefreshRequestSchema.safeParse(request.body);
      return isProjectId(request.params.id) &&
        request.query.size === 0 &&
        parsed.success
        ? {
            ok: true,
            value: { projectId: request.params.id, request: parsed.data },
          }
        : fail(
            "Expected only a knowledge UUID, reviewed catalog revision and served repository key.",
          );
    },
    subject: ({ projectId, request }) => ({
      target: projectId,
      family: "project-knowledge-refresh",
      requestId: request.requestId,
      inputHash: knowledgeOperationHash(projectId, request),
    }),
    effect: ({ projectId, request }) =>
      reply(async () =>
        knowledgeReceiptSchema.parse(await service.refresh(projectId, request)),
      ),
  };
  const recover = (
    operation: "publish" | "retire",
  ): ActionRoute<Identity & { requestHash: string }> => ({
    kind: "action",
    method: "POST",
    path: base + "/:requestId/" + operation,
    action: "project.knowledge." + operation,
    maxBodyBytes: 1024,
    rejectDuplicateBodyKeys: true,
    validate: (request) => {
      const selected = identity(request),
        parsed = z
          .object({ requestHash: z.string().regex(/^[a-f0-9]{64}$/) })
          .strict()
          .safeParse(request.body);
      return selected.ok && parsed.success
        ? { ok: true, value: { ...selected.value, ...parsed.data } }
        : fail("Expected the exact saved knowledge UUID and original hash.");
    },
    subject: ({ projectId, requestId, requestHash }) => ({
      target: projectId,
      family: "project-knowledge-refresh",
      requestId,
      inputHash: requestHash,
    }),
    effect: ({ projectId, requestId, requestHash }) =>
      reply(async () => {
        const original = service.receipt(projectId, requestId);
        if (original.requestHash !== requestHash)
          throw new ConversationError(
            409,
            "The saved knowledge original does not match the reviewed hash.",
          );
        return knowledgeReceiptSchema.parse(
          await service[operation](projectId, requestId),
        );
      }),
  });
  return {
    reads: [status, receipt],
    actions: [refresh, recover("publish"), recover("retire")],
  };
}
