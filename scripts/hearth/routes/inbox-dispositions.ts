import { z } from "zod";
import {
  type InboxDispositionOriginal,
  inboxDispositionOriginalSchema,
} from "../../../types/inbox";
import {
  createInboxDispositionStore,
  InboxDispositionError,
  MAX_INBOX_DISPOSITION_POST_BYTES,
} from "../../inbox/disposition-store";
import { isProjectId } from "../../projects/store";
import type { ActionRoute, ReadRoute, RouteReply, RouteRequest } from "../api";
import type { ValidationResult } from "../validate";
import { fail, noParameters } from "./operator-reads";

function errorReply(error: unknown): RouteReply {
  return error instanceof InboxDispositionError
    ? { status: error.status, error: error.message }
    : {
        status: 503,
        error:
          "Inbox disposition storage is unavailable. Read the saved original before continuing.",
      };
}

async function answer(
  work: () => unknown | Promise<unknown>,
): Promise<RouteReply> {
  try {
    return { status: 200, data: await work() };
  } catch (error) {
    return errorReply(error);
  }
}

function projectId(request: RouteRequest): ValidationResult<string> {
  const empty = noParameters(request);
  if (!empty.ok) return empty;
  const id = request.params["id"];
  return isProjectId(id)
    ? { ok: true, value: id }
    : fail("Expected a project id.");
}

const requestIdSchema = z
  .string()
  .uuid()
  .refine((value) => value === value.toLowerCase());

function original(
  request: RouteRequest,
  servedWorkspace: string,
): ValidationResult<{
  projectId: string;
  original: InboxDispositionOriginal;
}> {
  const id = projectId(request);
  if (!id.ok) return id;
  const parsed = inboxDispositionOriginalSchema.safeParse(request.body);
  return parsed.success && parsed.data.workspace === servedWorkspace
    ? { ok: true, value: { projectId: id.value, original: parsed.data } }
    : fail("The Inbox disposition original is invalid.");
}

export function createInboxDispositionRoutes(
  home: string,
  workspace: string,
  storeFactory: (
    home: string,
  ) => ReturnType<
    typeof createInboxDispositionStore
  > = createInboxDispositionStore,
) {
  const store = storeFactory(home);
  const list: ReadRoute<string> = {
    kind: "read",
    method: "GET",
    operatorOnly: true,
    path: "/projects/:id/inbox-dispositions",
    validate: projectId,
    read: (id) => answer(() => store.collection(id, workspace)),
  };
  const exact: ReadRoute<{ projectId: string; requestId: string }> = {
    kind: "read",
    method: "GET",
    operatorOnly: true,
    path: "/projects/:id/inbox-dispositions/requests/:requestId",
    validate(request) {
      const id = projectId(request);
      if (!id.ok) return id;
      const requestId = requestIdSchema.safeParse(request.params["requestId"]);
      return requestId.success
        ? {
            ok: true,
            value: { projectId: id.value, requestId: requestId.data },
          }
        : fail("Expected an Inbox request UUID.");
    },
    read: ({ projectId: id, requestId }) =>
      answer(() => {
        const found = store.original(id, requestId, workspace);
        if (!found)
          throw new InboxDispositionError(
            404,
            "original-missing",
            "The exact Inbox original is not retained.",
          );
        return found;
      }),
  };
  const reserve: ActionRoute<{
    projectId: string;
    original: InboxDispositionOriginal;
  }> = {
    kind: "action",
    method: "POST",
    operatorOnly: true,
    path: "/projects/:id/inbox-dispositions/requests",
    action: "inbox.disposition.reserve",
    rejectDuplicateBodyKeys: true,
    maxBodyBytes: MAX_INBOX_DISPOSITION_POST_BYTES,
    validate: (request) => original(request, workspace),
    subject: ({ original }) => ({ requestId: original.requestId }),
    effect: ({ projectId: id, original: body }) =>
      answer(() => store.reserve(id, workspace, body)),
  };
  const apply: ActionRoute<{
    projectId: string;
    original: InboxDispositionOriginal;
  }> = {
    kind: "action",
    method: "POST",
    operatorOnly: true,
    path: "/projects/:id/inbox-dispositions",
    action: "inbox.disposition.set",
    rejectDuplicateBodyKeys: true,
    maxBodyBytes: MAX_INBOX_DISPOSITION_POST_BYTES,
    validate: (request) => original(request, workspace),
    subject: ({ original }) => ({ requestId: original.requestId }),
    effect: async ({ projectId: id, original: body }) => {
      try {
        const saved = await store.apply(id, workspace, body);
        return {
          status: saved.receipt.phase === "refused" ? 409 : 200,
          data: saved,
        };
      } catch (error) {
        return errorReply(error);
      }
    },
  };
  const discard: ActionRoute<{
    projectId: string;
    requestId: string;
    original: InboxDispositionOriginal;
  }> = {
    kind: "action",
    method: "POST",
    operatorOnly: true,
    path: "/projects/:id/inbox-dispositions/requests/:requestId/discard",
    action: "inbox.disposition.discard",
    rejectDuplicateBodyKeys: true,
    maxBodyBytes: MAX_INBOX_DISPOSITION_POST_BYTES,
    validate(request) {
      const checked = original(request, workspace);
      if (!checked.ok) return checked;
      const requestId = requestIdSchema.safeParse(request.params["requestId"]);
      return requestId.success
        ? {
            ok: true,
            value: {
              ...checked.value,
              requestId: requestId.data,
            },
          }
        : fail("Expected an Inbox request UUID.");
    },
    subject: ({ original: body }) => ({ requestId: body.requestId }),
    effect: async ({ projectId: id, requestId, original: body }) => {
      try {
        const saved = await store.discard(id, requestId, workspace, body);
        return { status: 200, data: saved };
      } catch (error) {
        return errorReply(error);
      }
    },
  };
  return {
    reads: [list, exact] as const,
    actions: [reserve, apply, discard] as const,
  };
}
