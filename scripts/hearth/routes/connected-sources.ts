import { createHash } from "node:crypto";
import { z } from "zod";
import type { WorkspaceSourceInstance } from "../../projects/connected-source-instance";
import {
  SOURCE_RESPONSE_BYTES,
  sourceAuthorizeSchema,
  sourceEpicIdsSchema,
  sourceProjectIdSchema,
  sourceRefSchema,
  sourceRevokeSchema,
} from "../../projects/connected-source-protocol";
import type { ConnectedSources } from "../../projects/connected-source-service";
import { ProjectStoreError } from "../../projects/store";
import type { ActionRoute, ReadRoute, RouteReply, RouteRequest } from "../api";
import type { ValidationResult } from "../validate";
import { fail, noParameters } from "./operator-reads";

const projectSchema = z.object({ id: sourceProjectIdSchema }).strict();
const requestSchema = projectSchema.extend({ requestId: z.uuid() }).strict();
const workspaceSchema = projectSchema
  .extend({ workspaceRef: sourceRefSchema })
  .strict();
const revision = z.number().int().safe().nonnegative();
const previewSchema = workspaceSchema
  .extend({ revision, epicIds: sourceEpicIdsSchema })
  .strict();
const ownPreviewSchema = projectSchema
  .extend({
    revision,
    epicIds: sourceEpicIdsSchema,
    instanceId: z.uuid(),
    trackerId: z.uuid(),
  })
  .strict();
const authorizeSchema = projectSchema
  .extend({ request: sourceAuthorizeSchema })
  .strict();
const revokeSchema = workspaceSchema.extend({ grantId: z.uuid() }).strict();
function checked<T>(schema: z.ZodType<T>, value: unknown): ValidationResult<T> {
  const parsed = schema.safeParse(value);
  return parsed.success
    ? { ok: true, value: parsed.data }
    : fail("Invalid workspace source request.");
}
function once(query: URLSearchParams, key: string): string | undefined {
  const values = query.getAll(key);
  return values.length === 1 ? values[0] : undefined;
}
function queryPreview(request: RouteRequest, own: boolean) {
  const allowed = new Set(
      own
        ? ["revision", "epicId", "instance", "trackerId"]
        : ["revision", "epicId"],
    ),
    raw = once(request.query, "revision");
  if (
    [...request.query.keys()].some((key) => !allowed.has(key)) ||
    raw === undefined ||
    !/^(0|[1-9]\d*)$/.test(raw)
  )
    return null;
  return {
    id: request.params.id,
    revision: Number(raw),
    epicIds: request.query.getAll("epicId"),
    ...(own
      ? {
          instanceId: once(request.query, "instance"),
          trackerId: once(request.query, "trackerId"),
        }
      : { workspaceRef: request.params.workspaceRef }),
  };
}
async function answer(
  work: () => unknown | Promise<unknown>,
): Promise<RouteReply> {
  try {
    const data = await work();
    if (Buffer.byteLength(JSON.stringify(data)) > SOURCE_RESPONSE_BYTES)
      throw Error();
    return { status: 200, data };
  } catch (error) {
    return error instanceof ProjectStoreError
      ? { status: error.status, error: error.message }
      : {
          status: 503,
          error: "Workspace source data is unavailable or incomplete.",
        };
  }
}
export function connectedSourceRoutes(
  sources: ConnectedSources,
  own: WorkspaceSourceInstance,
) {
  const identity: ReadRoute<null> = {
    kind: "read",
    method: "GET",
    operatorOnly: true,
    path: "/workspace-source/identity",
    validate: noParameters,
    read: () => answer(() => own.identity()),
  };
  const sourcePreview: ReadRoute<z.infer<typeof ownPreviewSchema>> = {
    kind: "read",
    method: "GET",
    operatorOnly: true,
    path: "/workspace-source/projects/:id/preview",
    validate: (request) =>
      checked(ownPreviewSchema, queryPreview(request, true)),
    read: (input) =>
      answer(() =>
        own.preview({
          projectId: input.id,
          revision: input.revision,
          epicIds: input.epicIds,
          instanceId: input.instanceId,
          trackerId: input.trackerId,
        }),
      ),
  };
  const list: ReadRoute<z.infer<typeof projectSchema>> = {
    kind: "read",
    method: "GET",
    operatorOnly: true,
    path: "/projects/:id/settings/sources",
    validate: (request) =>
      request.query.size
        ? fail("Unexpected source query.")
        : checked(projectSchema, { id: request.params.id }),
    read: (input) => answer(() => sources.list(input.id)),
  };
  const original: ReadRoute<z.infer<typeof requestSchema>> = {
    kind: "read",
    method: "GET",
    operatorOnly: true,
    path: "/projects/:id/settings/sources/requests/:requestId",
    validate: (request) =>
      request.query.size
        ? fail("Unexpected source query.")
        : checked(requestSchema, {
            id: request.params.id,
            requestId: request.params.requestId,
          }),
    read: (input) => answer(() => sources.original(input.id, input.requestId)),
  };
  const preview: ReadRoute<z.infer<typeof previewSchema>> = {
    kind: "read",
    method: "GET",
    operatorOnly: true,
    path: "/projects/:id/settings/sources/:workspaceRef/preview",
    validate: (request) => checked(previewSchema, queryPreview(request, false)),
    read: (input) =>
      answer(() =>
        sources.preview(
          input.id,
          input.workspaceRef,
          input.revision,
          input.epicIds,
        ),
      ),
  };
  const authorize: ActionRoute<z.infer<typeof authorizeSchema>> = {
    kind: "action",
    method: "POST",
    path: "/projects/:id/settings/sources/authorize",
    action: "project.source.authorize",
    maxBodyBytes: 1024,
    rejectDuplicateBodyKeys: true,
    validate: (request) =>
      request.query.size
        ? fail("Unexpected source query.")
        : checked(authorizeSchema, {
            id: request.params.id,
            request: request.body,
          }),
    subject: (input) => ({
      target: input.id,
      family: "project-source-authorization",
      requestId: input.request.requestId,
      inputHash: createHash("sha256")
        .update(JSON.stringify([input.id, input.request]))
        .digest("hex"),
    }),
    effect: (input) => answer(() => sources.authorize(input.id, input.request)),
  };
  const revoke: ActionRoute<z.infer<typeof revokeSchema>> = {
    kind: "action",
    method: "POST",
    path: "/projects/:id/settings/sources/:workspaceRef/revoke",
    action: "project.source.revoke",
    maxBodyBytes: 256,
    rejectDuplicateBodyKeys: true,
    validate: (request) => {
      if (request.query.size) return fail("Unexpected source query.");
      const body = sourceRevokeSchema.safeParse(request.body);
      return body.success
        ? checked(revokeSchema, {
            id: request.params.id,
            workspaceRef: request.params.workspaceRef,
            ...body.data,
          })
        : fail("Invalid source revocation.");
    },
    subject: (input) => ({
      target: input.id,
      family: "project-source-revoke",
      requestId: input.grantId,
      inputHash: createHash("sha256")
        .update(JSON.stringify(input))
        .digest("hex"),
    }),
    effect: (input) =>
      answer(() => sources.revoke(input.id, input.workspaceRef, input.grantId)),
  };
  return {
    reads: [identity, sourcePreview, list, original, preview],
    actions: [authorize, revoke],
  };
}
