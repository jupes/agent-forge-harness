import type { KeeperSessionStartRequest } from "../../../types/keeper-session-start";
import { ConversationError } from "../../conversations/error";
import { isConversationRequestId } from "../../conversations/store";
import {
  keeperSessionProposalIdSchema,
  keeperSessionStartRequestSchema,
  MAX_KEEPER_SESSION_START_BODY_BYTES,
} from "../../keeper/session-start-protocol";
import { createKeeperSessionStartService } from "../../keeper/session-start-service";
import { isProjectId, ProjectStoreError } from "../../projects/store";
import { sessionStartReceiptSchema } from "../../sessions/protocol";
import { SessionRegistryError } from "../../sessions/registry";
import { sessionStartSchema } from "../../sessions/request-protocol";
import type { ActionRoute, ReadRoute, RouteReply, RouteRequest } from "../api";
import type { ValidationResult } from "../validate";
import { fail, noParameters, type ReadDeps } from "./operator-reads";
import type { createOwnedSessionRoutes } from "./sessions";

type Address = { projectId: string; proposalId: string };
const path = "/projects/:id/keeper/proposals/:proposalId/session-start";

/** This audited bridge owns approval; the existing owned journal owns dispatch. */
export function createKeeperSessionStartRoutes(
  home: string,
  deps: ReadDeps,
  owned: Pick<
    ReturnType<typeof createOwnedSessionRoutes>,
    "service" | "prepare"
  >,
) {
  const service = createKeeperSessionStartService({
    home,
    root: deps.root,
    // The proposal producer authorizes only an explicit Claude review. Keep
    // current provider dispatch and managed-origin fences inside the facade.
    sessions: {
      async start(projectId, raw) {
        const input = sessionStartSchema.parse(raw);
        return sessionStartReceiptSchema.parse(
          await owned.service.start(projectId, input),
        );
      },
      list: (projectId) =>
        owned.service
          .list(projectId)
          .flatMap((record) =>
            record.provider === "claude" && !record.origin ? [record] : [],
          ),
      read: (projectId, sessionId, query) =>
        owned.service.read(projectId, sessionId, query),
    },
    prepare: owned.prepare,
  });
  const address = (request: RouteRequest): ValidationResult<Address> => {
    const projectId = request.params["id"],
      proposalId = keeperSessionProposalIdSchema.safeParse(
        request.params["proposalId"],
      );
    if (!isProjectId(projectId) || !proposalId.success)
      return fail("Expected a project and verified session proposal id.");
    return {
      ok: true as const,
      value: { projectId, proposalId: proposalId.data },
    };
  };
  const answer = async (
    work: () => unknown | Promise<unknown>,
  ): Promise<RouteReply> => {
    try {
      return { status: 200, data: await work() };
    } catch (error) {
      if (
        error instanceof ConversationError ||
        error instanceof ProjectStoreError ||
        error instanceof SessionRegistryError
      )
        return { status: error.status, error: error.message };
      throw error;
    }
  };
  const read: ReadRoute<Address & { requestId?: string }> = {
    kind: "read",
    method: "GET",
    path,
    operatorOnly: true,
    validate: (request) => {
      const selected = address(request);
      if (!selected.ok) return selected;
      if (
        [...request.query.keys()].some(
          (key) =>
            key !== "requestId" || request.query.getAll(key).length !== 1,
        )
      )
        return fail("Unsupported original session Start query.");
      const requestId = request.query.get("requestId");
      if (requestId !== null && !isConversationRequestId(requestId))
        return fail("Expected the original session Start UUID.");
      return {
        ok: true,
        value: {
          ...selected.value,
          ...(requestId !== null ? { requestId } : {}),
        },
      };
    },
    read: ({ projectId, proposalId, requestId }) =>
      answer(() => service.read(projectId, proposalId, requestId)),
  };
  const start: ActionRoute<Address & { body: KeeperSessionStartRequest }> = {
    kind: "action",
    method: "POST",
    path,
    action: "keeper.proposal.session.start",
    maxBodyBytes: MAX_KEEPER_SESSION_START_BODY_BYTES,
    validate: (request) => {
      const selected = address(request),
        query = noParameters(request);
      if (!selected.ok) return selected;
      if (!query.ok) return query;
      const parsed = keeperSessionStartRequestSchema.safeParse(request.body);
      return parsed.success
        ? { ok: true, value: { ...selected.value, body: parsed.data } }
        : fail(
            "Expected the full strict reviewed session Start and original proposal source.",
          );
    },
    subject: ({ proposalId, body }) => ({
      target: proposalId,
      ...(body.start.beadId ? { beadId: body.start.beadId } : {}),
    }),
    effect: ({ projectId, proposalId, body }, context) =>
      answer(() => {
        if (!context)
          throw new ConversationError(
            503,
            "The confirmed operator audit is unavailable. No session approval was admitted.",
          );
        return service.start(projectId, proposalId, body, context.auditEventId);
      }),
  };
  return { service, read, start, close: service.close };
}
