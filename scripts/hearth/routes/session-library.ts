import type { SessionArchiveRequest } from "../../../types/session-library";
import { ConversationError } from "../../conversations/error";
import { createSessionLibrary } from "../../sessions/library";
import { sessionArchiveRequestSchema } from "../../sessions/library-protocol";
import {
  ownedSessionIdSchema,
  sessionProjectIdSchema,
  sessionRequestIdSchema,
} from "../../sessions/protocol";
import { SessionRegistryError } from "../../sessions/registry";
import type { ActionRoute, ReadRoute, RouteReply, RouteRequest } from "../api";
import type { ValidationResult } from "../validate";
import { fail, noParameters } from "./operator-reads";

type Address = { projectId: string; sessionId: string };
async function answer(
  work: () => unknown | Promise<unknown>,
): Promise<RouteReply> {
  try {
    return { status: 200, data: await work() };
  } catch (error) {
    if (
      error instanceof ConversationError ||
      error instanceof SessionRegistryError
    )
      return { status: error.status, error: error.message };
    throw error;
  }
}

/** All reads remain operator-protected; the shared runner authorizes/audits archive. */
export function createSessionLibraryRoutes(options: {
  home: string;
  root: string;
  readable(projectId: string): void;
}) {
  const library = createSessionLibrary({
    ...options,
    validateAccess: options.readable,
  });
  const project = (request: RouteRequest): ValidationResult<string> => {
    const parsed = sessionProjectIdSchema.safeParse(request.params["id"]);
    return parsed.success
      ? { ok: true, value: parsed.data }
      : fail("Expected a project id.");
  };
  const address = (request: RouteRequest): ValidationResult<Address> => {
    const selected = project(request),
      session = ownedSessionIdSchema.safeParse(request.params["sessionId"]);
    return !selected.ok
      ? selected
      : !session.success
        ? fail("Expected an owned session id.")
        : {
            ok: true,
            value: { projectId: selected.value, sessionId: session.data },
          };
  };
  const list: ReadRoute<string> = {
    kind: "read",
    method: "GET",
    path: "/projects/:id/session-library",
    operatorOnly: true,
    validate(request) {
      const selected = project(request),
        query = noParameters(request);
      return !selected.ok ? selected : !query.ok ? query : selected;
    },
    read: (projectId) =>
      answer(() => {
        options.readable(projectId);
        return library.list(projectId);
      }),
  };
  const read: ReadRoute<Address & { requestId?: string }> = {
    kind: "read",
    method: "GET",
    path: "/projects/:id/sessions/:sessionId/archive",
    operatorOnly: true,
    validate(request) {
      const selected = address(request);
      if (!selected.ok) return selected;
      if (
        [...request.query.keys()].some(
          (key) =>
            key !== "requestId" || request.query.getAll(key).length !== 1,
        )
      )
        return fail("Unsupported archive query.");
      const requestId = request.query.get("requestId");
      if (
        requestId !== null &&
        !sessionRequestIdSchema.safeParse(requestId).success
      )
        return fail("Expected the original archive request UUID.");
      return {
        ok: true,
        value: {
          ...selected.value,
          ...(requestId === null ? {} : { requestId }),
        },
      };
    },
    read: ({ projectId, sessionId, requestId }) =>
      answer(() => {
        options.readable(projectId);
        return library.read(projectId, sessionId, requestId);
      }),
  };
  const exportTranscript: ReadRoute<Address> = {
    kind: "read",
    method: "GET",
    path: "/projects/:id/sessions/:sessionId/export",
    operatorOnly: true,
    validate(request) {
      const selected = address(request),
        query = noParameters(request);
      return !selected.ok ? selected : !query.ok ? query : selected;
    },
    read: ({ projectId, sessionId }) =>
      answer(() => {
        options.readable(projectId);
        return library.exportTranscript(projectId, sessionId);
      }),
  };
  const archive: ActionRoute<Address & { input: SessionArchiveRequest }> = {
    kind: "action",
    method: "POST",
    path: read.path,
    action: "session.archive",
    maxBodyBytes: 4096,
    validate(request) {
      const selected = address(request),
        query = noParameters(request);
      if (!selected.ok) return selected;
      if (!query.ok) return query;
      const parsed = sessionArchiveRequestSchema.safeParse(request.body);
      return parsed.success
        ? { ok: true, value: { ...selected.value, input: parsed.data } }
        : fail(
            "Expected the original archive UUID, revision and preference. No process control is accepted.",
          );
    },
    subject: ({ sessionId }) => ({ target: sessionId }),
    effect: ({ projectId, sessionId, input }) =>
      answer(() => {
        options.readable(projectId);
        return library.archive(projectId, sessionId, input);
      }),
  };
  return { reads: [list, read, exportTranscript], archive };
}
