import { ConversationError } from "../../conversations/error";
import { isConversationRequestId } from "../../conversations/store";
import type { KeeperOperatorPost } from "../../keeper/operator-post";
import {
  keeperProposalApprovalSchema,
  keeperProposalDismissalSchema,
} from "../../keeper/proposal-protocol";
import { createKeeperProposalService } from "../../keeper/proposal-service";
import { queryEventPage } from "../../ledger/query";
import { isProjectId, ProjectStoreError } from "../../projects/store";
import type { ActionRoute, ReadRoute, RouteReply, RouteRequest } from "../api";
import type { ValidationResult } from "../validate";
import {
  bodyFields,
  fail,
  hearthLedger,
  noParameters,
  type ReadDeps,
} from "./operator-reads";
import type { ProjectSnapshot } from "./project-summaries";

export function keeperProposalRoutes(
  home: string,
  deps: ReadDeps,
  load: () => Promise<ProjectSnapshot>,
  post?: KeeperOperatorPost,
) {
  const service = createKeeperProposalService({
    home,
    root: deps.root,
    configHome: deps.configHome,
    load,
    post,
    activity: (id, target) => {
      const event = queryEventPage(
        {
          workspace: deps.workspace,
          kinds: ["operator.action"],
          afterId: id - 1,
          limit: 1,
        },
        hearthLedger(deps.ledgerPath),
      ).events[0];
      if (
        !event ||
        event.id !== id ||
        event.kind !== "operator.action" ||
        event.payload.target !== target ||
        !["keeper.proposal.approve", "keeper.proposal.dismiss"].includes(
          event.payload.action,
        )
      )
        return null;
      return {
        id: event.id,
        at: event.ts,
        action: event.payload.action,
        surface: event.payload.surface,
        target,
      };
    },
  });
  const address = (request: RouteRequest): ValidationResult<string> => {
    const query = noParameters(request);
    if (!query.ok) return { ok: false, error: query.error };
    const id = request.params["id"];
    return isProjectId(id)
      ? { ok: true as const, value: id }
      : { ok: false, error: "Expected a project id." };
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
      throw error;
    }
  };
  const read: ReadRoute<{ id: string; requestId?: string }> = {
    kind: "read",
    method: "GET",
    path: "/projects/:id/keeper/proposals",
    operatorOnly: true,
    validate: (request) => {
      const id = request.params["id"];
      if (!isProjectId(id)) return fail("Expected a project id.");
      if (
        [...request.query.keys()].some(
          (key) =>
            key !== "requestId" || request.query.getAll(key).length !== 1,
        )
      )
        return fail("Unsupported proposal query.");
      const requestId = request.query.get("requestId");
      if (requestId !== null && !isConversationRequestId(requestId))
        return fail("Expected a review request id.");
      return {
        ok: true,
        value: { id, ...(requestId !== null ? { requestId } : {}) },
      };
    },
    read: ({ id, ...query }) => answer(() => service.read(id, query)),
  };
  type Review = {
    projectId: string;
    body: {
      id: string;
      sourceHash: string;
      requestId: string;
      expectedRevision: number;
      draft?: unknown;
    };
  };
  const action = (dismiss: boolean): ActionRoute<Review> => ({
    kind: "action",
    method: "POST",
    path: `/projects/:id/keeper/proposals/${dismiss ? "dismiss" : "approve"}`,
    action: `keeper.proposal.${dismiss ? "dismiss" : "approve"}`,
    maxBodyBytes: 30_000,
    validate: (request) => {
      const id = address(request);
      if (!id.ok) return id;
      const body = bodyFields(
        request,
        dismiss
          ? ["id", "sourceHash", "requestId", "expectedRevision"]
          : ["id", "sourceHash", "requestId", "expectedRevision", "draft"],
      );
      if (!body.ok) return body;
      const parsed = dismiss
        ? keeperProposalDismissalSchema.safeParse(body.value)
        : keeperProposalApprovalSchema.safeParse(body.value);
      return parsed.success
        ? { ok: true, value: { projectId: id.value, body: parsed.data } }
        : fail("Expected a strict reviewed Keeper proposal request.");
    },
    subject: (input) => ({ target: input.body.id }),
    effect: (input, context) =>
      answer(() => {
        if (!context)
          throw new ConversationError(
            503,
            "The confirmed approval audit is unavailable. No review was admitted.",
          );
        return dismiss
          ? service.dismiss(input.projectId, input.body, context.auditEventId)
          : service.approve(input.projectId, input.body, context.auditEventId);
      }),
  });
  return {
    read,
    approve: action(false),
    dismiss: action(true),
    close: service.close,
  };
}
