import type { CodexChatDecisionRequest } from "../../../types/codex-owned-chat";
import type { OwnedSessionStartRequest } from "../../../types/codex-owned-task";
import type { LedgerEventInput } from "../../../types/hearth";
import type { SessionMessage } from "../../../types/session-turn";
import { ConversationError } from "../../conversations/error";
import { parseSessionSend } from "../../conversations/protocol";
import { isConversationRequestId } from "../../conversations/store";
import type { AppendResult } from "../../ledger/append";
import { workspaceKey } from "../../projects/scope";
import {
  createProjectStore,
  isProjectId,
  ProjectStoreError,
} from "../../projects/store";
import type { SessionRuntime } from "../../sessions/admission";
import { createCodexChatPreview } from "../../sessions/codex-chat-owned-preview";
import { parseCodexChatDecision } from "../../sessions/codex-chat-owned-protocol";
import type { createCodexChatRuntime } from "../../sessions/codex-chat-runtime";
import { createCodexTaskPreview } from "../../sessions/codex-owned-preview";
import { parseOwnedSessionStart } from "../../sessions/codex-owned-protocol";
import type { createCodexTaskRuntime } from "../../sessions/codex-task-runtime";
import {
  createOwnedCodingSessionService,
  unavailableCodexChatRuntime,
  unavailableCodexTaskRuntime,
} from "../../sessions/owned-coding-service";
import { createSessionPreview } from "../../sessions/preview";
import { SessionRegistryError } from "../../sessions/registry";
import type {
  ActionRoute,
  ReadRoute,
  RouteReply,
  RouteRequest,
  StreamRoute,
} from "../api";
import { createConversationFeed } from "../conversation-feed";
import type { ValidationResult } from "../validate";
import {
  bodyFields,
  fail,
  noParameters,
  type ReadDeps,
} from "./operator-reads";
import type { ProjectSnapshot } from "./project-summaries";
import { createOwnedSessionLedger } from "./session-ledger";
import { createSessionLibraryRoutes } from "./session-library";
import { createSessionScopeValidator } from "./session-scope";

type Address = { projectId: string; sessionId: string };
type Dependencies = ReadDeps & {
  appendEvent(event: LedgerEventInput): AppendResult;
};
const isSessionId = (value: unknown): value is string =>
  typeof value === "string" &&
  value.startsWith("session-") &&
  value === value.toLowerCase() &&
  isConversationRequestId(value.slice(8));
const knownError = (
  error: unknown,
): error is ConversationError | ProjectStoreError | SessionRegistryError =>
  error instanceof ConversationError ||
  error instanceof ProjectStoreError ||
  error instanceof SessionRegistryError;

async function answer(
  status: number,
  work: () => unknown | Promise<unknown>,
): Promise<RouteReply> {
  try {
    return { status, data: await work() };
  } catch (error) {
    if (knownError(error))
      return { status: error.status, error: error.message };
    throw error;
  }
}

/** Owned coding routes use the same gate, operator token and audit runner as Keeper. */
export function createOwnedSessionRoutes(
  home: string,
  deps: Dependencies,
  load: () => Promise<ProjectSnapshot>,
  runtime: SessionRuntime,
  codexTaskRuntime?: ReturnType<typeof createCodexTaskRuntime>,
  codexChatRuntime?: ReturnType<typeof createCodexChatRuntime>,
) {
  const feed = createConversationFeed();
  const recordMetadata = createOwnedSessionLedger(home, deps);
  const validateScope = createSessionScopeValidator(home, deps, load);
  const preparePreview = createSessionPreview({
    root: deps.root,
    runtime,
    validateScope,
  });
  const prepareCodexPreview = createCodexTaskPreview({
    root: deps.root,
    runtime: codexTaskRuntime ?? unavailableCodexTaskRuntime,
    validateScope,
  });
  const prepareChatPreview = createCodexChatPreview({
    root: deps.root,
    runtime: codexChatRuntime ?? unavailableCodexChatRuntime,
    validateScope,
  });
  const service = createOwnedCodingSessionService({
    home,
    root: deps.root,
    runtime,
    codexTaskRuntime,
    codexChatRuntime,
    onApprovalChange: (sessionId) => feed.changed(sessionId),
    validateScope,
    onChange: (session, update) => {
      feed.changed(session.id);
      recordMetadata(session, update);
    },
  });
  const project = (request: RouteRequest): ValidationResult<string> => {
    const id = request.params["id"];
    return isProjectId(id)
      ? { ok: true, value: id }
      : fail("Expected a project id.");
  };
  const address = (request: RouteRequest): ValidationResult<Address> => {
    const selected = project(request);
    if (!selected.ok) return selected;
    const sessionId = request.params["sessionId"];
    return isSessionId(sessionId)
      ? { ok: true, value: { projectId: selected.value, sessionId } }
      : fail("Expected an owned session id.");
  };
  const readable = (projectId: string) => {
    const selected = createProjectStore(home)
      .read()
      .projects.find((item) => item.id === projectId);
    if (!selected)
      throw new ConversationError(
        404,
        "This project is not in the hearth catalog.",
      );
    if (
      !selected.workspaces.some(
        (item) => workspaceKey(item.root) === workspaceKey(deps.workspace),
      )
    )
      throw new ConversationError(
        409,
        "This hearth does not serve this project's workspace.",
      );
  };
  const list: ReadRoute<string> = {
    kind: "read",
    method: "GET",
    path: "/projects/:id/sessions",
    operatorOnly: true,
    validate: (request) => {
      const selected = project(request),
        query = noParameters(request);
      return !selected.ok ? selected : !query.ok ? query : selected;
    },
    read: (projectId) =>
      answer(200, () => {
        readable(projectId);
        return service.list(projectId);
      }),
  };
  const library = createSessionLibraryRoutes({
    home,
    root: deps.root,
    readable,
  });
  const read: ReadRoute<
    Address & { after?: number; limit?: number; requestId?: string }
  > = {
    kind: "read",
    method: "GET",
    path: "/projects/:id/sessions/:sessionId",
    operatorOnly: true,
    validate: (request) => {
      const selected = address(request);
      if (!selected.ok) return selected;
      if (
        [...request.query.keys()].some(
          (key) =>
            !["after", "limit", "requestId"].includes(key) ||
            request.query.getAll(key).length !== 1,
        )
      )
        return fail("Unsupported session query.");
      const after = request.query.get("after"),
        limit = request.query.get("limit"),
        requestId = request.query.get("requestId");
      if (
        (after !== null &&
          (!/^\d+$/.test(after) || !Number.isSafeInteger(Number(after)))) ||
        (limit !== null &&
          (!/^\d+$/.test(limit) || Number(limit) < 1 || Number(limit) > 100)) ||
        (requestId !== null && !isConversationRequestId(requestId))
      )
        return fail(
          "Expected a bounded session cursor, page size or request id.",
        );
      return {
        ok: true,
        value: {
          ...selected.value,
          ...(after !== null ? { after: Number(after) } : {}),
          ...(limit !== null ? { limit: Number(limit) } : {}),
          ...(requestId !== null ? { requestId } : {}),
        },
      };
    },
    read: ({ projectId, sessionId, ...query }) =>
      answer(200, () => {
        readable(projectId);
        return service.read(projectId, sessionId, query);
      }),
  };
  const events: StreamRoute<Address & { after: number }> = {
    kind: "stream",
    method: "GET",
    path: "/projects/:id/sessions/:sessionId/events",
    operatorOnly: true,
    validate: (request) => {
      const selected = address(request),
        query = noParameters(request);
      if (!selected.ok) return selected;
      if (!query.ok) return query;
      const after = request.headers["last-event-id"] ?? "0";
      if (
        typeof after !== "string" ||
        !/^\d+$/.test(after) ||
        !Number.isSafeInteger(Number(after))
      )
        return fail("Expected a bounded session cursor.");
      return { ok: true, value: { ...selected.value, after: Number(after) } };
    },
    open: async ({ projectId, sessionId, after }, req, res) => {
      try {
        readable(projectId);
        return await feed.open(
          sessionId,
          after,
          (_id, query) => service.read(projectId, sessionId, query),
          req,
          res,
        );
      } catch (error) {
        if (knownError(error))
          return { status: error.status, error: error.message };
        throw error;
      }
    },
  };
  const start: ActionRoute<{
    projectId: string;
    input: OwnedSessionStartRequest;
  }> = {
    kind: "action",
    method: "POST",
    path: "/projects/:id/sessions",
    action: "session.start",
    maxBodyBytes: 2_200_000,
    validate: (request) => {
      const selected = project(request),
        query = noParameters(request);
      if (!selected.ok) return selected;
      if (!query.ok) return query;
      try {
        return {
          ok: true,
          value: {
            projectId: selected.value,
            input: parseOwnedSessionStart(request.body),
          },
        };
      } catch {
        return fail("Expected a strict supported session Start request.");
      }
    },
    subject: ({ projectId, input }) => ({
      target: projectId,
      ...(input.beadId ? { beadId: input.beadId } : {}),
    }),
    effect: ({ projectId, input }) =>
      answer(202, () => service.start(projectId, input)),
  };
  const send: ActionRoute<Address & { input: SessionMessage }> = {
    kind: "action",
    method: "POST",
    path: "/projects/:id/sessions/:sessionId/turns",
    action: "session.turn.send",
    maxBodyBytes: 2_200_000,
    validate: (request) => {
      const selected = address(request),
        query = noParameters(request);
      if (!selected.ok) return selected;
      if (!query.ok) return query;
      try {
        return {
          ok: true,
          value: { ...selected.value, input: parseSessionSend(request.body) },
        };
      } catch {
        return fail(
          "Expected an original request id, revision and bounded session message.",
        );
      }
    },
    subject: ({ sessionId }) => ({ target: sessionId }),
    effect: ({ projectId, sessionId, input }) =>
      answer(202, () => service.send(projectId, sessionId, input)),
  };
  const preview: ActionRoute<{
    projectId: string;
    input: OwnedSessionStartRequest;
  }> = {
    ...start,
    path: "/projects/:id/sessions/preview",
    action: "session.preview",
    effect: ({ projectId, input }) =>
      answer(200, () =>
        "provider" in input
          ? input.launch.mode === "chat"
            ? prepareChatPreview(projectId, input)
            : prepareCodexPreview(projectId, input)
          : preparePreview(projectId, input),
      ),
  };
  const stop: ActionRoute<Address & { requestId: string }> = {
    kind: "action",
    method: "POST",
    path: "/projects/:id/sessions/:sessionId/stop",
    action: "session.turn.stop",
    validate: (request) => {
      const selected = address(request),
        query = noParameters(request),
        body = bodyFields(request, ["requestId"]);
      if (!selected.ok) return selected;
      if (!query.ok) return query;
      if (!body.ok) return body;
      const requestId = body.value["requestId"];
      return isConversationRequestId(requestId)
        ? { ok: true, value: { ...selected.value, requestId } }
        : fail("Expected the turn's original request id.");
    },
    subject: ({ sessionId }) => ({ target: sessionId }),
    effect: ({ projectId, sessionId, requestId }) =>
      answer(200, () => service.stop(projectId, sessionId, requestId)),
  };
  const approvals: ReadRoute<Address & { requestId?: string }> = {
    kind: "read",
    method: "GET",
    path: "/projects/:id/sessions/:sessionId/approvals",
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
        return fail("Unsupported approval query.");
      const requestId = request.query.get("requestId");
      if (requestId !== null && !isConversationRequestId(requestId))
        return fail("Expected the original decision UUID.");
      return {
        ok: true,
        value: {
          ...selected.value,
          ...(requestId === null ? {} : { requestId }),
        },
      };
    },
    read: ({ projectId, sessionId, requestId }) =>
      answer(200, () => {
        readable(projectId);
        return service.approvals(projectId, sessionId, requestId);
      }),
  };
  const decide: ActionRoute<Address & { input: CodexChatDecisionRequest }> = {
    kind: "action",
    method: "POST",
    path: "/projects/:id/sessions/:sessionId/approval-decisions",
    action: "session.approval.decide",
    maxBodyBytes: 2048,
    validate: (request) => {
      const selected = address(request),
        query = noParameters(request);
      if (!selected.ok) return selected;
      if (!query.ok) return query;
      try {
        return {
          ok: true,
          value: {
            ...selected.value,
            input: parseCodexChatDecision(request.body),
          },
        };
      } catch {
        return fail(
          "Expected an original decision UUID, accepted turn, opaque approval and offered narrow decision.",
        );
      }
    },
    subject: ({ sessionId }) => ({ target: sessionId }),
    effect: ({ projectId, sessionId, input }) =>
      answer(200, () => service.decide(projectId, sessionId, input)),
  };
  return {
    list,
    read,
    events,
    start,
    preview,
    send,
    stop,
    approvals,
    decide,
    library,
    close: async () => {
      feed.close();
      await service.close();
    },
  };
}
