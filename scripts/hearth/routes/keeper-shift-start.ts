import type { KeeperShiftStartRequest } from "../../../types/keeper-shift-start";
import { ConversationError } from "../../conversations/error";
import {
  keeperShiftProposalIdSchema,
  keeperShiftStartRequestSchema,
} from "../../keeper/shift-start-protocol";
import { createKeeperShiftStartService } from "../../keeper/shift-start-service";
import { isProjectId, ProjectStoreError } from "../../projects/store";
import { shiftRequestIdSchema } from "../../shifts/protocol";
import type { createProjectShiftService } from "../../shifts/service";
import type { ActionRoute, ReadRoute, RouteReply, RouteRequest } from "../api";
import type { ValidationResult } from "../validate";
import { fail, noParameters, type ReadDeps } from "./operator-reads";

const path = "/projects/:id/keeper/proposals/:proposalId/shift-start";
const MAX_KEEPER_SHIFT_START_BODY_BYTES = 8_000;
type Address = { projectId: string; proposalId: string };

/** An audited Keeper review bridge over the one canonical project Shift owner. */
export function createKeeperShiftStartRoutes(
  home: string,
  deps: ReadDeps,
  shifts: Pick<ReturnType<typeof createProjectShiftService>, "read" | "start">,
) {
  const service = createKeeperShiftStartService({
    home,
    root: deps.root,
    shifts,
  });
  const address = (request: RouteRequest): ValidationResult<Address> => {
    const projectId = request.params["id"],
      proposalId = keeperShiftProposalIdSchema.safeParse(
        request.params["proposalId"],
      );
    if (!isProjectId(projectId) || !proposalId.success)
      return fail("Expected a project and verified Shift proposal id.");
    return { ok: true, value: { projectId, proposalId: proposalId.data } };
  };
  const answer = async (
    work: () => unknown | Promise<unknown>,
  ): Promise<RouteReply> => {
    try {
      return { status: 200, data: await work() };
    } catch (error) {
      if (
        error instanceof ConversationError ||
        error instanceof ProjectStoreError
      )
        return { status: error.status, error: error.message };
      return {
        status: 503,
        error:
          "The original Keeper Shift review could not be verified. Its saved input has been kept.",
      };
    }
  };
  const read: ReadRoute<Address & { requestId: string }> = {
    kind: "read",
    method: "GET",
    path: `${path}/:requestId`,
    operatorOnly: true,
    validate(request) {
      const selected = address(request),
        query = noParameters(request),
        requestId = shiftRequestIdSchema.safeParse(request.params["requestId"]);
      if (!selected.ok) return selected;
      if (!query.ok) return query;
      return requestId.success
        ? { ok: true, value: { ...selected.value, requestId: requestId.data } }
        : fail("Expected the original Shift Start request UUID.");
    },
    read: ({ projectId, proposalId, requestId }) =>
      answer(() => service.read(projectId, proposalId, requestId)),
  };
  const start: ActionRoute<Address & { body: KeeperShiftStartRequest }> = {
    kind: "action",
    method: "POST",
    path,
    action: "keeper.proposal.shift.start",
    maxBodyBytes: MAX_KEEPER_SHIFT_START_BODY_BYTES,
    validate(request) {
      const selected = address(request),
        query = noParameters(request);
      if (!selected.ok) return selected;
      if (!query.ok) return query;
      const body = keeperShiftStartRequestSchema.safeParse(request.body);
      return body.success
        ? { ok: true, value: { ...selected.value, body: body.data } }
        : fail(
            "Expected the full strict reviewed Shift Start and proposal source.",
          );
    },
    subject: ({ proposalId }) => ({ target: proposalId }),
    effect: ({ projectId, proposalId, body }, context) =>
      answer(() => {
        if (!context)
          throw new ConversationError(
            503,
            "The confirmed Start audit is unavailable. No Keeper Shift review was admitted.",
          );
        return service.start(projectId, proposalId, body, context.auditEventId);
      }),
  };
  return { service, read, start, close: service.close };
}
