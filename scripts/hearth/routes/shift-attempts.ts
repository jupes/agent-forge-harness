import { ConversationError } from "../../conversations/error";
import {
  ownedSessionIdSchema,
  sessionProjectIdSchema,
  sessionRequestIdSchema,
} from "../../sessions/identity-protocol";
import { SessionRegistryError } from "../../sessions/registry";
import { createProjectShiftAttemptReader } from "../../shifts/attempt-read";
import type {
  ApiRoute,
  ReadRoute,
  RouteReply,
  RouteRequest,
  StreamRoute,
} from "../api";
import { createConversationFeed } from "../conversation-feed";
import type { ValidationResult } from "../validate";
import { fail, noParameters } from "./operator-reads";

type Original = { projectId: string; originalRequestId: string };
type Attempt = Original & { sessionId: string };
const known = (
  error: unknown,
): error is ConversationError | SessionRegistryError =>
  error instanceof ConversationError || error instanceof SessionRegistryError;
const answer = async (
  work: () => unknown | Promise<unknown>,
): Promise<RouteReply> => {
  try {
    return { status: 200, data: await work() };
  } catch (error) {
    if (known(error)) return { status: error.status, error: error.message };
    throw error;
  }
};

/** Private replay only. Every body read re-verifies its immutable original; feeds never acquire control authority. */
export function createProjectShiftAttemptRoutes(options: {
  home: string;
  root: string;
}) {
  const reader = createProjectShiftAttemptReader(options),
    feed = createConversationFeed();
  const original = (request: RouteRequest): ValidationResult<Original> => {
    const project = sessionProjectIdSchema.safeParse(request.params["id"]),
      uuid = sessionRequestIdSchema.safeParse(request.params["requestId"]);
    return project.success && uuid.success
      ? {
          ok: true,
          value: { projectId: project.data, originalRequestId: uuid.data },
        }
      : fail("Expected a project and original shift Start UUID.");
  };
  const attempt = (request: RouteRequest): ValidationResult<Attempt> => {
    const selected = original(request),
      session = ownedSessionIdSchema.safeParse(request.params["sessionId"]);
    if (!selected.ok) return selected;
    return session.success
      ? { ok: true, value: { ...selected.value, sessionId: session.data } }
      : fail("Expected an owned attempt session id.");
  };
  const base = "/projects/:id/shifts/requests/:requestId/attempts";
  const list: ReadRoute<Original> = {
    kind: "read",
    method: "GET",
    path: base,
    operatorOnly: true,
    validate(request) {
      const selected = original(request),
        query = noParameters(request);
      return !selected.ok ? selected : !query.ok ? query : selected;
    },
    read: ({ projectId, originalRequestId }) =>
      answer(() => reader.list(projectId, originalRequestId)),
  };
  const read: ReadRoute<
    Attempt & { after?: number; limit?: number; turnRequestId?: string }
  > = {
    kind: "read",
    method: "GET",
    path: `${base}/:sessionId`,
    operatorOnly: true,
    validate(request) {
      const selected = attempt(request);
      if (!selected.ok) return selected;
      if (
        [...request.query.keys()].some(
          (key) =>
            !["after", "limit", "requestId"].includes(key) ||
            request.query.getAll(key).length !== 1,
        )
      )
        return fail("Unsupported private attempt query.");
      const after = request.query.get("after"),
        limit = request.query.get("limit"),
        turn = request.query.get("requestId");
      if (
        (after !== null &&
          (!/^\d+$/.test(after) || !Number.isSafeInteger(Number(after)))) ||
        (limit !== null &&
          (!/^\d+$/.test(limit) || Number(limit) < 1 || Number(limit) > 100)) ||
        (turn !== null && !sessionRequestIdSchema.safeParse(turn).success)
      )
        return fail(
          "Expected a bounded private attempt cursor, page size or original turn UUID.",
        );
      return {
        ok: true,
        value: {
          ...selected.value,
          ...(after !== null ? { after: Number(after) } : {}),
          ...(limit !== null ? { limit: Number(limit) } : {}),
          ...(turn !== null ? { turnRequestId: turn } : {}),
        },
      };
    },
    read: ({
      projectId,
      originalRequestId,
      sessionId,
      turnRequestId,
      ...query
    }) =>
      answer(() =>
        reader.read(projectId, originalRequestId, sessionId, {
          ...query,
          ...(turnRequestId ? { requestId: turnRequestId } : {}),
        }),
      ),
  };
  const events: StreamRoute<Attempt & { after: number }> = {
    kind: "stream",
    method: "GET",
    path: `${base}/:sessionId/events`,
    operatorOnly: true,
    validate(request) {
      const selected = attempt(request),
        query = noParameters(request);
      if (!selected.ok) return selected;
      if (!query.ok) return query;
      const after = request.headers["last-event-id"] ?? "0";
      return typeof after === "string" &&
        /^\d+$/.test(after) &&
        Number.isSafeInteger(Number(after))
        ? { ok: true, value: { ...selected.value, after: Number(after) } }
        : fail("Expected a bounded private attempt cursor.");
    },
    async open({ projectId, originalRequestId, sessionId, after }, req, res) {
      try {
        return await feed.open(
          sessionId,
          after,
          (_id, query) =>
            reader.read(projectId, originalRequestId, sessionId, query),
          req,
          res,
        );
      } catch (error) {
        if (known(error)) return { status: error.status, error: error.message };
        throw error;
      }
    },
  };
  return {
    routes: [list, read, events] as ApiRoute[],
    close: () => feed.close(),
  };
}
