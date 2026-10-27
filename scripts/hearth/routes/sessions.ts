import { createHash } from "node:crypto";
import type { CodexChatDecisionRequest } from "../../../types/codex-owned-chat";
import type { OwnedSessionStartRequest } from "../../../types/codex-owned-task";
import type { GeminiChatDecisionRequest } from "../../../types/gemini-owned-chat";
import type { LedgerEventInput } from "../../../types/hearth";
import type { SessionOperationIdentityPage } from "../../../types/session-operation-identities";
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
import {
  CODEX_CHAT_FORK_PROTOCOL_VERSION,
  codexChatForkIntentSchema,
  codexChatForkOriginalHash,
  codexChatForkOriginalHashInput,
} from "../../sessions/codex-chat-fork-protocol";
import { createCodexChatPreview } from "../../sessions/codex-chat-owned-preview";
import { parseCodexChatDecision } from "../../sessions/codex-chat-owned-protocol";
import type { createCodexChatRuntime } from "../../sessions/codex-chat-runtime";
import { createCodexTaskPreview } from "../../sessions/codex-owned-preview";
import {
  canonicalOwnedSessionStart,
  parseOwnedSessionStart,
} from "../../sessions/codex-owned-protocol";
import type { createCodexTaskRuntime } from "../../sessions/codex-task-runtime";
import { createGeminiChatPreview } from "../../sessions/gemini-chat-owned-preview";
import { parseGeminiChatDecision } from "../../sessions/gemini-chat-owned-protocol";
import type { createGeminiChatRuntime } from "../../sessions/gemini-chat-runtime";
import { createGeminiTaskPreview } from "../../sessions/gemini-owned-preview";
import type { createGeminiTaskRuntime } from "../../sessions/gemini-task-runtime";
import { sessionRequestHashSchema } from "../../sessions/identity-protocol";
import {
  createOwnedCodingSessionService,
  unavailableCodexChatRuntime,
  unavailableCodexTaskRuntime,
  unavailableGeminiChatRuntime,
  unavailableGeminiTaskRuntime,
} from "../../sessions/owned-coding-service";
import { canonicalSessionInput } from "../../sessions/preparation";
import { createSessionPreview } from "../../sessions/preview";
import { SessionRegistryError } from "../../sessions/registry";
import type {
  ActionContext,
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
  providerRuntimes: {
    codexTaskRuntime?: ReturnType<typeof createCodexTaskRuntime> | undefined;
    codexChatRuntime?: ReturnType<typeof createCodexChatRuntime> | undefined;
    geminiTaskRuntime?: ReturnType<typeof createGeminiTaskRuntime> | undefined;
    geminiChatRuntime?: ReturnType<typeof createGeminiChatRuntime> | undefined;
  } = {},
) {
  const {
    codexTaskRuntime,
    codexChatRuntime,
    geminiTaskRuntime,
    geminiChatRuntime,
  } = providerRuntimes;
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
  const prepareGeminiPreview = createGeminiTaskPreview({
    root: deps.root,
    runtime: geminiTaskRuntime ?? unavailableGeminiTaskRuntime,
    validateScope,
  });
  const prepareChatPreview = createCodexChatPreview({
    root: deps.root,
    runtime: codexChatRuntime ?? unavailableCodexChatRuntime,
    validateScope,
  });
  const prepareGeminiChatPreview = createGeminiChatPreview({
    root: deps.root,
    runtime: geminiChatRuntime ?? unavailableGeminiChatRuntime,
    validateScope,
  });
  const service = createOwnedCodingSessionService({
    home,
    root: deps.root,
    runtime,
    codexTaskRuntime,
    codexChatRuntime,
    geminiTaskRuntime,
    geminiChatRuntime,
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
  const identityList: ReadRoute<string> = {
    kind: "read",
    method: "GET",
    path: "/projects/:id/session-start-identities",
    operatorOnly: true,
    validate: (request) => {
      const selected = project(request),
        query = noParameters(request);
      return !selected.ok ? selected : !query.ok ? query : selected;
    },
    read: (projectId) =>
      answer(200, () => {
        readable(projectId);
        return service.listIdentities(projectId);
      }),
  };
  const identityOperations: ReadRoute<string> = {
    kind: "read",
    method: "GET",
    path: "/projects/:id/session-operation-identities",
    operatorOnly: true,
    validate: (request) => {
      const selected = project(request),
        query = noParameters(request);
      return !selected.ok ? selected : !query.ok ? query : selected;
    },
    read: (projectId) =>
      answer(200, () => {
        readable(projectId);
        return service.listOperationIdentities(
          projectId,
        ) as Promise<SessionOperationIdentityPage>;
      }),
  };
  const forkOriginal: ReadRoute<{ projectId: string; requestId: string }> = {
    kind: "read",
    method: "GET",
    path: "/projects/:id/codex-chat-forks/:requestId",
    operatorOnly: true,
    validate: (request) => {
      const selected = project(request),
        query = noParameters(request),
        requestId = request.params["requestId"];
      if (!selected.ok) return selected;
      if (!query.ok) return query;
      return isConversationRequestId(requestId)
        ? { ok: true, value: { projectId: selected.value, requestId } }
        : fail("Expected a lowercase Codex Fork request UUID.");
    },
    read: ({ projectId, requestId }) =>
      answer(200, () => {
        readable(projectId);
        return service.readForkOriginal(projectId, requestId);
      }),
  };
  const fork: ActionRoute<{
    projectId: string;
    parentSessionId: string;
    input: { requestId: string; throughTurnRequestId: string };
  }> = {
    kind: "action",
    method: "POST",
    path: "/projects/:id/sessions/:sessionId/forks",
    action: "session.fork",
    maxBodyBytes: 2_048,
    validate: (request) => {
      const selected = address(request),
        query = noParameters(request),
        body = bodyFields(request, ["requestId", "throughTurnRequestId"]);
      if (!selected.ok) return selected;
      if (!query.ok) return query;
      if (!body.ok) return body;
      const input = codexChatForkIntentSchema.safeParse(body.value);
      return input.success
        ? {
            ok: true,
            value: {
              projectId: selected.value.projectId,
              parentSessionId: selected.value.sessionId,
              input: input.data,
            },
          }
        : fail("Expected a strict Codex Chat Fork request.");
    },
    subject: ({ projectId, parentSessionId, input }) => ({
      target: `codex-chat-fork:${projectId}:${parentSessionId}`,
      family: "codex-chat-fork",
      requestId: input.requestId,
      inputHash: codexChatForkOriginalHash(
        codexChatForkOriginalHashInput({
          projectId,
          workspaceKey: workspaceKey(deps.workspace),
          parentSessionId,
          throughTurnRequestId: input.throughTurnRequestId,
          requestId: input.requestId,
          protocolVersion: CODEX_CHAT_FORK_PROTOCOL_VERSION,
        }),
      ),
    }),
    effect: (input, context?: ActionContext) =>
      answer(200, () => {
        readable(input.projectId);
        if (
          !context ||
          !Number.isSafeInteger(context.auditEventId) ||
          context.auditEventId <= 0
        )
          throw new ConversationError(
            503,
            "A confirmed operator audit receipt is required before Fork.",
          );
        return service.fork(
          input.projectId,
          input.parentSessionId,
          input.input,
          context.auditEventId,
        );
      }),
  };
  const forkReserve: ActionRoute<{
    projectId: string;
    parentSessionId: string;
    input: { requestId: string; throughTurnRequestId: string };
  }> = {
    kind: "action",
    method: "POST",
    path: "/projects/:id/sessions/:sessionId/fork-reservations",
    action: "session.fork.reserve",
    maxBodyBytes: 2_048,
    validate: (request) => {
      const selected = address(request),
        query = noParameters(request),
        body = bodyFields(request, ["requestId", "throughTurnRequestId"]);
      if (!selected.ok) return selected;
      if (!query.ok) return query;
      if (!body.ok) return body;
      const input = codexChatForkIntentSchema.safeParse(body.value);
      return input.success
        ? {
            ok: true,
            value: {
              projectId: selected.value.projectId,
              parentSessionId: selected.value.sessionId,
              input: input.data,
            },
          }
        : fail("Expected a strict Codex Chat Fork reservation request.");
    },
    subject: ({ projectId, parentSessionId, input }) => ({
      target: `codex-chat-fork:${projectId}:${parentSessionId}`,
      family: "codex-chat-fork",
      requestId: input.requestId,
      inputHash: codexChatForkOriginalHash(
        codexChatForkOriginalHashInput({
          projectId,
          workspaceKey: workspaceKey(deps.workspace),
          parentSessionId,
          throughTurnRequestId: input.throughTurnRequestId,
          requestId: input.requestId,
          protocolVersion: CODEX_CHAT_FORK_PROTOCOL_VERSION,
        }),
      ),
    }),
    effect: (input, context?: ActionContext) =>
      answer(200, () => {
        readable(input.projectId);
        if (
          !context ||
          !Number.isSafeInteger(context.auditEventId) ||
          context.auditEventId <= 0
        )
          throw new ConversationError(
            503,
            "A confirmed operator audit receipt is required before Fork reservation.",
          );
        return service.reserveFork(
          input.projectId,
          input.parentSessionId,
          input.input,
          context.auditEventId,
        );
      }),
  };
  const forkRetire: ActionRoute<{
    projectId: string;
    parentSessionId: string;
    requestId: string;
    requestHash: string;
  }> = {
    kind: "action",
    method: "POST",
    path: "/projects/:id/sessions/:sessionId/fork-reservations/:requestId/retire",
    action: "session.fork.retire",
    maxBodyBytes: 2_048,
    validate: (request) => {
      const selected = address(request),
        query = noParameters(request),
        body = bodyFields(request, ["requestHash"]);
      if (!selected.ok) return selected;
      if (!query.ok) return query;
      if (!body.ok) return body;
      const requestId = request.params["requestId"],
        hash = sessionRequestHashSchema.safeParse(body.value["requestHash"]);
      if (!isConversationRequestId(requestId))
        return fail("Expected the exact Fork request UUID.");
      return hash.success
        ? {
            ok: true,
            value: {
              projectId: selected.value.projectId,
              parentSessionId: selected.value.sessionId,
              requestId,
              requestHash: hash.data,
            },
          }
        : fail("Expected the exact Fork request hash.");
    },
    subject: ({ projectId, parentSessionId, requestId, requestHash }) => ({
      target: `codex-chat-fork:${projectId}:${parentSessionId}`,
      family: "codex-chat-fork",
      requestId,
      inputHash: requestHash,
    }),
    effect: (input, context?: ActionContext) =>
      answer(200, () => {
        readable(input.projectId);
        if (
          !context ||
          !Number.isSafeInteger(context.auditEventId) ||
          context.auditEventId <= 0
        )
          throw new ConversationError(
            503,
            "A confirmed operator audit receipt is required before Fork retirement.",
          );
        return service.retireFork(
          input.projectId,
          input.parentSessionId,
          input.requestId,
          input.requestHash,
          context.auditEventId,
        );
      }),
  };
  const identityReserve: ActionRoute<{
    projectId: string;
    input: OwnedSessionStartRequest;
  }> = {
    kind: "action",
    method: "POST",
    path: "/projects/:id/session-start-identities",
    action: "session.start.identity.reserve",
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
    subject: ({ projectId, input }) => {
      const requestHash = createHash("sha256")
        .update(canonicalOwnedSessionStart(input))
        .digest("hex");
      return {
        target: `owned-session-start:${projectId}:${input.requestId}:${requestHash}`,
      };
    },
    effect: ({ projectId, input }) =>
      answer(200, () => {
        readable(projectId);
        return service.reserveIdentity(projectId, input);
      }),
  };
  const identityRetire: ActionRoute<{
    projectId: string;
    requestId: string;
    requestHash: string;
  }> = {
    kind: "action",
    method: "POST",
    path: "/projects/:id/session-start-identities/:requestId/retire",
    action: "session.start.identity.retire",
    maxBodyBytes: 2_048,
    validate: (request) => {
      const selected = project(request),
        query = noParameters(request),
        body = bodyFields(request, ["requestHash"]);
      if (!selected.ok) return selected;
      if (!query.ok) return query;
      if (!body.ok) return body;
      const requestId = request.params["requestId"],
        hash = body.value["requestHash"];
      if (!isConversationRequestId(requestId))
        return fail("Expected a lowercase request UUID.");
      const parsedHash = sessionRequestHashSchema.safeParse(hash);
      return parsedHash.success
        ? {
            ok: true,
            value: {
              projectId: selected.value,
              requestId,
              requestHash: parsedHash.data,
            },
          }
        : fail("Expected the request hash.");
    },
    subject: ({ projectId, requestId, requestHash }) => ({
      target: `owned-session-start:${projectId}:${requestId}:${requestHash}`,
    }),
    effect: ({ projectId, requestId, requestHash }) =>
      answer(200, () => {
        readable(projectId);
        return service.retireIdentity(projectId, requestId, requestHash);
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
  const forkTurnRead: ReadRoute<
    Address & { after?: number; limit?: number; requestId?: string }
  > = {
    kind: "read",
    method: "GET",
    path: "/projects/:id/sessions/:sessionId/fork-turns",
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
        return fail("Unsupported Fork-child transcript query.");
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
          "Expected a bounded Fork-child cursor, page size or request id.",
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
        return service.readForkChild(projectId, sessionId, query);
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
  const forkTurn: ActionRoute<Address & { input: SessionMessage }> = {
    kind: "action",
    method: "POST",
    path: "/projects/:id/sessions/:sessionId/fork-turns",
    action: "session.fork.turn",
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
          "Expected a fresh request id, exact revision and bounded child message.",
        );
      }
    },
    subject: ({ projectId, sessionId, input }) => ({
      target: `codex-chat-fork-child:${projectId}:${sessionId}`,
      family: "codex-chat-fork",
      requestId: input.requestId,
      inputHash: createHash("sha256")
        .update(canonicalSessionInput(input))
        .digest("hex"),
    }),
    effect: (input, context?: ActionContext) =>
      answer(202, () => {
        readable(input.projectId);
        if (
          !context ||
          !Number.isSafeInteger(context.auditEventId) ||
          context.auditEventId <= 0
        )
          throw new ConversationError(
            503,
            "A confirmed operator audit receipt is required before a Fork child turn.",
          );
        return service.forkTurn(
          input.projectId,
          input.sessionId,
          input.input,
          context.auditEventId,
        );
      }),
  };
  const preview: ActionRoute<{
    projectId: string;
    input: OwnedSessionStartRequest;
  }> = {
    ...start,
    path: "/projects/:id/sessions/preview",
    action: "session.preview",
    effect: ({ projectId, input }) =>
      answer(200, () => {
        if ("provider" in input && input.provider === "gemini")
          return input.launch.mode === "chat"
            ? prepareGeminiChatPreview(projectId, input)
            : prepareGeminiPreview(projectId, input);
        return "provider" in input
          ? input.launch.mode === "chat"
            ? prepareChatPreview(projectId, input)
            : prepareCodexPreview(projectId, input)
          : preparePreview(projectId, input);
      }),
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
  const forkApprovals: ReadRoute<Address & { requestId?: string }> = {
    kind: "read",
    method: "GET",
    path: "/projects/:id/sessions/:sessionId/fork-approvals",
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
        return fail("Unsupported Fork approval query.");
      const requestId = request.query.get("requestId");
      if (requestId !== null && !isConversationRequestId(requestId))
        return fail("Expected the original Fork decision UUID.");
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
        return service.forkApprovals(projectId, sessionId, requestId);
      }),
  };
  const decide: ActionRoute<
    Address & { input: CodexChatDecisionRequest | GeminiChatDecisionRequest }
  > = {
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
            input:
              typeof request.body === "object" &&
              request.body !== null &&
              Object.hasOwn(request.body, "optionId")
                ? parseGeminiChatDecision(request.body)
                : parseCodexChatDecision(request.body),
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
  const forkDecide: ActionRoute<Address & { input: CodexChatDecisionRequest }> =
    {
      kind: "action",
      method: "POST",
      path: "/projects/:id/sessions/:sessionId/fork-approval-decisions",
      action: "session.fork.approval.decide",
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
            "Expected an original decision UUID, accepted child turn, opaque approval and offered decision.",
          );
        }
      },
      subject: ({ projectId, sessionId, input }) => ({
        target: `codex-chat-fork-child:${projectId}:${sessionId}`,
        family: "codex-chat-fork-approval",
        requestId: input.requestId,
        inputHash: createHash("sha256")
          .update(
            JSON.stringify({
              requestId: input.requestId,
              turnRequestId: input.turnRequestId,
              approvalId: input.approvalId,
              decision: input.decision,
            }),
          )
          .digest("hex"),
      }),
      effect: ({ projectId, sessionId, input }, context?: ActionContext) =>
        answer(200, () => {
          readable(projectId);
          if (
            !context ||
            !Number.isSafeInteger(context.auditEventId) ||
            context.auditEventId <= 0
          )
            throw new ConversationError(
              503,
              "A confirmed operator audit receipt is required before a Fork-child decision.",
            );
          return service.decideFork(projectId, sessionId, input);
        }),
    };
  const forkStop: ActionRoute<Address & { requestId: string }> = {
    kind: "action",
    method: "POST",
    path: "/projects/:id/sessions/:sessionId/fork-stop",
    action: "session.fork.stop",
    maxBodyBytes: 256,
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
        : fail("Expected the Fork child's original turn request id.");
    },
    subject: ({ projectId, sessionId, requestId }) => ({
      target: `codex-chat-fork-child:${projectId}:${sessionId}`,
      family: "codex-chat-fork-stop",
      requestId,
      inputHash: createHash("sha256")
        .update(JSON.stringify({ requestId }))
        .digest("hex"),
    }),
    effect: ({ projectId, sessionId, requestId }, context?: ActionContext) =>
      answer(200, () => {
        readable(projectId);
        if (
          !context ||
          !Number.isSafeInteger(context.auditEventId) ||
          context.auditEventId <= 0
        )
          throw new ConversationError(
            503,
            "A confirmed operator audit receipt is required before Fork-child Stop.",
          );
        return service.stopFork(projectId, sessionId, requestId);
      }),
  };
  return {
    /** Trusted server coordination only; these are not additional HTTP routes. */
    service,
    prepare: preparePreview,
    list,
    identityList,
    identityOperations,
    forkOriginal,
    fork,
    forkReserve,
    forkRetire,
    identityReserve,
    identityRetire,
    read,
    forkTurnRead,
    forkApprovals,
    events,
    start,
    preview,
    send,
    forkTurn,
    stop,
    approvals,
    forkDecide,
    forkStop,
    decide,
    library,
    close: async () => {
      feed.close();
      await service.close();
    },
  };
}
