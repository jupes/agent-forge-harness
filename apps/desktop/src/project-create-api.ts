import { z } from "zod";
import {
  NotSent,
  type OperatorPost,
  type OperatorRead,
} from "../../../docs/js/operator";
import type {
  ProjectCreateOptions,
  ProjectScopePreview,
} from "../../../scripts/projects/create-options-protocol";
import {
  projectCreateOptionsSchema,
  projectScopePreviewSchema,
} from "../../../scripts/projects/create-options-protocol";
import type { ProjectCreateReserveRequest } from "../../../scripts/projects/create-protocol";
import {
  projectCreateCommitSchema,
  projectCreateDiscoverySchema,
  projectCreateIdentitySchema,
  projectCreateReserveSchema,
  projectCreateRetireSchema,
} from "../../../scripts/projects/create-protocol";
import type { SmithsView } from "../../../types/hearth";
import { PROJECT_COLOR_IDS } from "../../../types/projects";
import { canonicalProjectCreateJson } from "./project-create-identities";
import { smithsViewSchema } from "./smiths-protocol";

const envelope = z
  .object({ ok: z.literal(true), data: z.unknown(), error: z.null() })
  .strict();
const optionsBytes = { maxBodyBytes: 1_048_576 };
const identityBytes = { maxBodyBytes: 524_288 };
const identityPath = "/__agent-forge/projects/create-reservations";
const projectRecordSchema = z
  .object({
    id: z
      .string()
      .regex(
        /^project-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      ),
    slug: z.string().min(1).max(48),
    name: z.string().min(1).max(120),
    description: z.string().max(500),
    icon: z.string().min(1).max(16),
    workspaces: z
      .array(
        z
          .object({
            root: z.string().min(1).max(1024),
            repositories: z.array(z.string().min(1).max(1024)).max(32),
            epicIds: z.array(z.string().min(1).max(200)).max(64),
          })
          .strict(),
      )
      .min(1)
      .max(16),
    keeperSmith: z.string().min(1).max(1024).optional(),
    color: z.enum(PROJECT_COLOR_IDS).optional(),
    pinned: z.boolean(),
    archived: z.boolean(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();
const publicCatalogSchema = z
  .object({
    version: z.literal(1),
    revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    projects: z.array(projectRecordSchema).max(10_000),
  })
  .strict();

export type ProjectCreateWriteResult<T> =
  | { state: "confirmed"; value: T }
  | { state: "not-sent"; message: string }
  | { state: "unknown"; message: string };

async function checkedData<T>(
  read: OperatorRead,
  path: string,
  limit: { maxBodyBytes: number },
  schema: z.ZodType<T>,
): Promise<T> {
  const response = await read(path, { method: "GET" }, limit);
  if (response.status !== 200)
    throw Error("Saved project creation details could not be verified.");
  let raw: unknown;
  try {
    raw = await response.json();
  } catch {
    throw Error("Saved project creation details could not be verified.");
  }
  const checkedEnvelope = envelope.safeParse(raw);
  const checked = schema.safeParse(
    checkedEnvelope.success ? checkedEnvelope.data.data : null,
  );
  if (!checked.success)
    throw Error("Saved project creation details could not be verified.");
  return checked.data;
}

/** Browser-safe, read-only access to the protected project-create producer. */
export function createProjectCreateApi(deps: {
  read: OperatorRead;
  post: OperatorPost;
}) {
  const read = deps.read;
  const write = async <T>(
    path: string,
    body: unknown,
    allowedStatuses: readonly number[],
    extract: (data: unknown) => T | null,
    unknownMessage: string,
  ): Promise<ProjectCreateWriteResult<T>> => {
    try {
      const response = await deps.post(path, body, identityBytes);
      if (response.status === 403)
        return {
          state: "not-sent",
          message: "Operator access refused this action before its effect.",
        };
      let raw: unknown;
      try {
        raw = await response.json();
      } catch {
        return { state: "unknown", message: unknownMessage };
      }
      const checked = envelope.safeParse(raw);
      const value = checked.success ? extract(checked.data.data) : null;
      if (value !== null && allowedStatuses.includes(response.status))
        return { state: "confirmed", value };
      return { state: "unknown", message: unknownMessage };
    } catch (error) {
      return error instanceof NotSent
        ? { state: "not-sent", message: error.message }
        : { state: "unknown", message: unknownMessage };
    }
  };
  return {
    options: () =>
      checkedData<ProjectCreateOptions>(
        read,
        "/__agent-forge/projects/create-options",
        optionsBytes,
        projectCreateOptionsSchema,
      ),
    discovery: () =>
      checkedData(
        read,
        identityPath,
        identityBytes,
        projectCreateDiscoverySchema,
      ),
    original: (requestId: string) =>
      checkedData(
        read,
        `${identityPath}/${encodeURIComponent(requestId)}`,
        identityBytes,
        projectCreateIdentitySchema,
      ),
    catalog: () =>
      checkedData(
        read,
        "/__agent-forge/projects",
        optionsBytes,
        publicCatalogSchema,
      ),
    smiths: () =>
      checkedData<SmithsView>(
        read,
        "/__agent-forge/smiths",
        optionsBytes,
        smithsViewSchema,
      ),
    async preview(slug: string, epicIds: readonly string[]) {
      const query = new URLSearchParams({ slug });
      for (const epicId of epicIds) query.append("epicId", epicId);
      return checkedData<ProjectScopePreview>(
        read,
        `/__agent-forge/projects/create-scope-preview?${query}`,
        optionsBytes,
        projectScopePreviewSchema,
      );
    },
    reserve(request: ProjectCreateReserveRequest, requestHash: string) {
      const frozen = projectCreateReserveSchema.parse(structuredClone(request));
      return write(
        identityPath,
        frozen,
        [200, 201],
        (data) => {
          const checked = projectCreateIdentitySchema.safeParse(data);
          return checked.success &&
            checked.data.requestId === request.requestId &&
            checked.data.requestHash === requestHash &&
            checked.data.state === "reserved" &&
            canonicalProjectCreateJson(checked.data.original) ===
              canonicalProjectCreateJson(frozen.original)
            ? checked.data
            : null;
        },
        "The project reservation may have reached the hearth.",
      );
    },
    commit(requestId: string, requestHash: string, reviewedScopeHash: string) {
      const body = projectCreateCommitSchema.parse({
        requestHash,
        reviewedScopeHash,
      });
      return write(
        `${identityPath}/${encodeURIComponent(requestId)}/commit`,
        body,
        [200],
        (data) => {
          if (
            typeof data !== "object" ||
            data === null ||
            !("operation" in data)
          )
            return null;
          const checked = projectCreateIdentitySchema.safeParse(data.operation);
          return checked.success &&
            checked.data.requestId === requestId &&
            checked.data.requestHash === requestHash &&
            checked.data.state === "created"
            ? checked.data
            : null;
        },
        "The project creation may have reached the hearth.",
      );
    },
    retire(requestId: string, requestHash: string) {
      const body = projectCreateRetireSchema.parse({ requestHash });
      return write(
        `${identityPath}/${encodeURIComponent(requestId)}/retire`,
        body,
        [200],
        (data) => {
          const checked = projectCreateIdentitySchema.safeParse(data);
          return checked.success &&
            checked.data.requestId === requestId &&
            checked.data.requestHash === requestHash &&
            checked.data.state === "retired-before-create"
            ? checked.data
            : null;
        },
        "The project reservation retirement may have reached the hearth.",
      );
    },
  };
}
