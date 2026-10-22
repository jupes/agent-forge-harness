import type { ConversationSend } from "../../../types/conversation";
import {
  createConversationService,
  type ValidateConversationAbout,
} from "../../conversations/service";
import {
  ConversationError,
  isConversationRequestId,
  parseConversationSend,
} from "../../conversations/store";
import type { ConversationTransport } from "../../conversations/transport";
import { isProjectId, ProjectStoreError } from "../../projects/store";
import type {
  ActionRoute,
  ReadRoute,
  RouteReply,
  RouteRequest,
  StreamRoute,
} from "../api";
import { createConversationFeed } from "../conversation-feed";
import type { ValidationResult } from "../validate";
import { bodyFields, fail, noParameters } from "./operator-reads";

const unavailable: ConversationTransport = {
  provider: "claude",
  async check() {
    throw new ConversationError(
      503,
      "The Keeper provider transport is unavailable in this build. No turn was accepted.",
    );
  },
  async run() {
    return { phase: "failed", reason: "No provider transport is configured." };
  },
};

async function answer(
  status: number,
  work: () => unknown | Promise<unknown>,
): Promise<RouteReply> {
  try {
    return { status, data: await work() };
  } catch (error) {
    if (
      error instanceof ConversationError ||
      error instanceof ProjectStoreError
    )
      return { status: error.status, error: error.message };
    throw error;
  }
}

export function conversationRoutes(
  home: string,
  root: string,
  transport: ConversationTransport = unavailable,
  validateAbout?: ValidateConversationAbout,
) {
  const feed = createConversationFeed();
  const service = createConversationService({
    home,
    root,
    transport,
    validateAbout,
    onChange: (update) => feed.changed(update.projectId),
  });
  const address = (request: RouteRequest): ValidationResult<string> => {
    const id = request.params["id"];
    return isProjectId(id)
      ? { ok: true as const, value: id }
      : fail("Expected a project id.");
  };
  const read: ReadRoute<{
    id: string;
    after?: number;
    limit?: number;
    requestId?: string;
  }> = {
    kind: "read",
    method: "GET",
    path: "/projects/:id/keeper",
    operatorOnly: true,
    validate: (request) => {
      const id = address(request);
      if (!id.ok) return id;
      if (
        [...request.query.keys()].some(
          (key) =>
            !["after", "limit", "requestId"].includes(key) ||
            request.query.getAll(key).length !== 1,
        )
      )
        return fail("Unsupported conversation query.");
      const after = request.query.get("after");
      const limit = request.query.get("limit");
      const requestId = request.query.get("requestId");
      if (
        (after !== null &&
          (!/^\d+$/.test(after) || !Number.isSafeInteger(Number(after)))) ||
        (limit !== null &&
          (!/^\d+$/.test(limit) || Number(limit) < 1 || Number(limit) > 100)) ||
        (requestId !== null && !isConversationRequestId(requestId))
      )
        return fail(
          "Expected a bounded conversation cursor, page size or request id.",
        );
      return {
        ok: true,
        value: {
          id: id.value,
          ...(after !== null ? { after: Number(after) } : {}),
          ...(limit !== null ? { limit: Number(limit) } : {}),
          ...(requestId !== null ? { requestId } : {}),
        },
      };
    },
    read: ({ id, ...query }) => answer(200, () => service.read(id, query)),
  };
  const send: ActionRoute<{ id: string; input: ConversationSend }> = {
    kind: "action",
    method: "POST",
    path: "/projects/:id/keeper/turns",
    action: "keeper.turn.send",
    maxBodyBytes: 80_000,
    validate: (request) => {
      const id = address(request);
      if (!id.ok) return id;
      const query = noParameters(request);
      if (!query.ok) return query;
      try {
        return {
          ok: true,
          value: { id: id.value, input: parseConversationSend(request.body) },
        };
      } catch {
        return fail(
          "Expected a request id, revision, message and bounded object references.",
        );
      }
    },
    subject: ({ id }) => ({ target: id }),
    effect: ({ id, input }) => answer(202, () => service.send(id, input)),
  };
  const stop: ActionRoute<{ id: string; requestId: string }> = {
    kind: "action",
    method: "POST",
    path: "/projects/:id/keeper/stop",
    action: "keeper.turn.stop",
    validate: (request) => {
      const id = address(request);
      if (!id.ok) return id;
      const body = bodyFields(request, ["requestId"]);
      if (!body.ok) return body;
      const requestId = body.value["requestId"];
      return isConversationRequestId(requestId)
        ? { ok: true, value: { id: id.value, requestId } }
        : fail("Expected the turn's request id.");
    },
    subject: ({ id }) => ({ target: id }),
    effect: ({ id, requestId }) =>
      answer(200, () => service.stop(id, requestId)),
  };
  const events: StreamRoute<{ id: string; after: number }> = {
    kind: "stream",
    method: "GET",
    path: "/projects/:id/keeper/events",
    operatorOnly: true,
    validate: (request) => {
      const id = address(request);
      if (!id.ok) return id;
      const params = noParameters(request);
      if (!params.ok) return params;
      const after = request.headers["last-event-id"] ?? "0";
      if (
        typeof after !== "string" ||
        !/^\d+$/.test(after) ||
        !Number.isSafeInteger(Number(after))
      )
        return fail("Expected a bounded conversation cursor.");
      return { ok: true, value: { id: id.value, after: Number(after) } };
    },
    open: async ({ id, after }, req, res) => {
      try {
        return await feed.open(id, after, service.read, req, res);
      } catch (error) {
        if (
          error instanceof ConversationError ||
          error instanceof ProjectStoreError
        )
          return { status: error.status, error: error.message };
        throw error;
      }
    },
  };
  return {
    read,
    send,
    stop,
    events,
    close: async () => {
      feed.close();
      await service.close();
    },
  };
}
