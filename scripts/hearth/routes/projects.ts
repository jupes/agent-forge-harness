import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import type {
  ProjectCatalog,
  ProjectPreferences,
} from "../../../types/projects";
import { readRepoContext } from "../../beads/repo-context";
import { resolveCheckout } from "../../ledger/workspace";
import {
  projectCreateCommitSchema,
  projectCreateReserveSchema,
  projectCreateRetireSchema,
} from "../../projects/create-protocol";
import { selectProjectBeads, workspaceKey } from "../../projects/scope";
import {
  createProjectStore,
  hashProjectCreateOriginal,
  isProjectId,
  ProjectStoreError,
} from "../../projects/store";
import type {
  ActionContext,
  ActionRoute,
  ReadRoute,
  RouteReply,
  RouteRequest,
} from "../api";
import type { ValidationResult } from "../validate";
import { localStateRoot } from "./dev-api";
import { bodyFields, fail, noParameters } from "./operator-reads";
import type { ProjectSnapshot } from "./project-summaries";

interface PreferenceChange {
  id: string;
  revision: number;
  patch: ProjectPreferences;
}

export interface ProjectCreateRouteOptions {
  root: string;
  workspace: string;
  loadScope(): Promise<ProjectSnapshot>;
}

function publicCatalog(catalog: ProjectCatalog) {
  return {
    version: catalog.version,
    revision: catalog.revision,
    projects: catalog.projects,
  };
}

function registeredRepositoryOptions(root: string): Set<string> {
  const allowed = new Set([workspaceKey(resolveCheckout(root).workspace)]);
  const local = localStateRoot(root);
  for (const name of readRepoContext(root).context?.knownRepos ?? []) {
    if (
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(name) ||
      name === "." ||
      name === ".."
    )
      continue;
    const path = join(local, "repos", name);
    try {
      if (!statSync(path).isDirectory() || !existsSync(join(path, ".git")))
        continue;
      allowed.add(workspaceKey(resolveCheckout(path).worktree));
    } catch {
      // An absent or unreadable checkout is not an onboarding option.
    }
  }
  return allowed;
}

function checkedScope(
  original: {
    slug: string;
    workspaces: Array<{
      root: string;
      repositories: string[];
      epicIds: string[];
    }>;
  },
  snapshot: ProjectSnapshot,
  options: ProjectCreateRouteOptions,
): { hash: string; count: number } {
  const scope = original.workspaces[0];
  if (!scope || original.workspaces.length !== 1)
    throw new ProjectStoreError(
      400,
      "A project must name the served workspace and its explicit scope.",
    );
  const served = workspaceKey(resolveCheckout(options.root).workspace);
  if (
    workspaceKey(options.workspace) !== served ||
    workspaceKey(snapshot.source.workspace) !== served ||
    workspaceKey(scope.root) !== served
  )
    throw new ProjectStoreError(
      409,
      "This hearth does not serve the selected project workspace.",
    );
  const allowedRepositories = registeredRepositoryOptions(options.root);
  if (
    scope.repositories.some(
      (repository) => !allowedRepositories.has(workspaceKey(repository)),
    )
  )
    throw new ProjectStoreError(
      400,
      "Choose only the served checkout or a registered repository.",
    );
  if (snapshot.source.issues === null)
    throw new ProjectStoreError(
      503,
      "The complete live project scope is unavailable. Refresh before reserving this project.",
    );
  const epics = new Set(
    snapshot.source.issues
      .filter((issue) => issue.type === "epic")
      .map((issue) => issue.id),
  );
  if (scope.epicIds.some((id) => !epics.has(id)))
    throw new ProjectStoreError(
      409,
      "A selected epic is missing from the current tracker read. Refresh project scope.",
    );
  const members = selectProjectBeads(
    { slug: original.slug, workspaces: [scope] },
    snapshot.source.workspace,
    snapshot.source.issues,
  )
    .map((issue) => issue.id)
    .sort();
  const proof = JSON.stringify({
    workspace: served,
    slug: original.slug,
    epicIds: [...scope.epicIds].sort(),
    members,
  });
  return {
    hash: createHash("sha256").update(proof).digest("hex"),
    count: members.length,
  };
}

function preferenceChange(
  request: RouteRequest,
): ValidationResult<PreferenceChange> {
  const checked = bodyFields(request, ["revision", "pinned", "archived"]);
  if (!checked.ok) return checked;
  const { revision, pinned, archived } = checked.value;
  const id = request.params["id"];
  if (!isProjectId(id)) return fail("Expected a project id.");
  if (
    typeof revision !== "number" ||
    !Number.isSafeInteger(revision) ||
    revision < 0 ||
    revision >= Number.MAX_SAFE_INTEGER
  )
    return fail("Expected a project catalog revision.");
  if (
    (pinned === undefined && archived === undefined) ||
    (pinned !== undefined && typeof pinned !== "boolean") ||
    (archived !== undefined && typeof archived !== "boolean")
  )
    return fail("Expected a boolean pin or archive preference.");
  return {
    ok: true,
    value: {
      id,
      revision,
      patch: {
        ...(typeof pinned === "boolean" ? { pinned } : {}),
        ...(typeof archived === "boolean" ? { archived } : {}),
      },
    },
  };
}

async function reply(
  work: () => unknown | Promise<unknown>,
  status = 200,
): Promise<RouteReply> {
  try {
    return { status, data: await work() };
  } catch (error) {
    if (error instanceof ProjectStoreError)
      return { status: error.status, error: error.message };
    throw error;
  }
}

function readIdentity(
  request: RouteRequest,
): ValidationResult<{ requestId: string }> {
  const value = request.params["requestId"];
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  )
    return fail("Expected a project create request id.");
  return { ok: true, value: { requestId: value } };
}

function reserveInput(request: RouteRequest): ValidationResult<{
  requestId: string;
  expectedCatalogRevision: number;
  original: {
    slug: string;
    name: string;
    description: string;
    icon: string;
    workspaces: Array<{
      root: string;
      repositories: string[];
      epicIds: string[];
    }>;
  };
}> {
  const parsed = projectCreateReserveSchema.safeParse(request.body);
  return parsed.success
    ? { ok: true, value: parsed.data }
    : fail("Expected a bounded project create reservation.");
}

function commitInput(request: RouteRequest): ValidationResult<{
  requestId: string;
  requestHash: string;
  reviewedScopeHash: string;
}> {
  const id = readIdentity(request);
  if (!id.ok) return id;
  const parsed = projectCreateCommitSchema.safeParse(request.body);
  return parsed.success
    ? { ok: true, value: { requestId: id.value.requestId, ...parsed.data } }
    : fail("Expected the saved project original hash and reviewed scope.");
}

function retireInput(
  request: RouteRequest,
): ValidationResult<{ requestId: string; requestHash: string }> {
  const id = readIdentity(request);
  if (!id.ok) return id;
  const parsed = projectCreateRetireSchema.safeParse(request.body);
  return parsed.success
    ? { ok: true, value: { requestId: id.value.requestId, ...parsed.data } }
    : fail("Expected the saved project original hash.");
}

/** The runner owns origin/token/validation/audit ordering for every mutation. */
export function projectRoutes(
  home: string,
  createOptions: ProjectCreateRouteOptions,
) {
  const store = createProjectStore(home);
  const projects: ReadRoute<null> = {
    kind: "read",
    method: "GET",
    path: "/projects",
    validate: noParameters,
    read: () => reply(() => publicCatalog(store.read())),
  };
  const preferences: ActionRoute<PreferenceChange> = {
    kind: "action",
    method: "POST",
    path: "/projects/:id/preferences",
    action: "project.preferences",
    validate: preferenceChange,
    subject: ({ id }) => ({ target: id }),
    effect: async ({ id, revision, patch }) =>
      reply(async () =>
        publicCatalog(await store.preferences(id, revision, patch)),
      ),
  };
  const createList: ReadRoute<null> = {
    kind: "read",
    method: "GET",
    path: "/projects/create-reservations",
    operatorOnly: true,
    validate: noParameters,
    read: () =>
      reply(() => ({
        complete: true as const,
        operations: store
          .listCreates()
          .map(
            ({
              requestId,
              requestHash,
              state,
              scopeCount,
              projectId,
              createdAt,
              updatedAt,
            }) => ({
              requestId,
              requestHash,
              state,
              scopeCount,
              projectId,
              createdAt,
              updatedAt,
            }),
          ),
      })),
  };
  const createOriginal: ReadRoute<{ requestId: string }> = {
    kind: "read",
    method: "GET",
    path: "/projects/create-reservations/:requestId",
    operatorOnly: true,
    validate: readIdentity,
    read: ({ requestId }) =>
      reply(() => {
        const operation = store.readCreate(requestId);
        if (!operation)
          throw new ProjectStoreError(
            404,
            "The exact project create original was not found.",
          );
        return operation;
      }),
  };
  const reserve: ActionRoute<
    ReturnType<typeof projectCreateReserveSchema.parse>
  > = {
    kind: "action",
    method: "POST",
    path: "/projects/create-reservations",
    action: "project.create.reserve",
    validate: reserveInput,
    subject: ({ requestId, original }) => ({
      target: original.slug,
      family: "project-create",
      requestId,
      inputHash: hashProjectCreateOriginal(original),
    }),
    effect: async (input, context) =>
      reply(async () => {
        if (!context?.auditEventId)
          throw new ProjectStoreError(
            503,
            "The project reservation was not audited.",
          );
        const existing = store.readCreate(input.requestId);
        const requestHash = hashProjectCreateOriginal(input.original);
        if (existing) {
          if (existing.requestHash !== requestHash)
            throw new ProjectStoreError(
              409,
              "This project create UUID is already bound to another original.",
            );
          return existing;
        }
        const snapshot = await createOptions.loadScope();
        const scope = checkedScope(input.original, snapshot, createOptions);
        const result = await store.reserveCreate({
          requestId: input.requestId,
          original: input.original,
          expectedCatalogRevision: input.expectedCatalogRevision,
          scopeHash: scope.hash,
          scopeCount: scope.count,
        });
        return result.operation;
      }, 201),
  };
  const commit: ActionRoute<{
    requestId: string;
    requestHash: string;
    reviewedScopeHash: string;
  }> = {
    kind: "action",
    method: "POST",
    path: "/projects/create-reservations/:requestId/commit",
    action: "project.create.commit",
    validate: commitInput,
    subject: ({ requestId, requestHash }) => ({
      target: requestId,
      family: "project-create",
      requestId,
      inputHash: requestHash,
    }),
    effect: async ({ requestId, requestHash, reviewedScopeHash }, context) =>
      reply(async () => {
        if (!context?.auditEventId)
          throw new ProjectStoreError(
            503,
            "The project creation was not audited.",
          );
        const existing = store.readCreate(requestId);
        if (!existing)
          throw new ProjectStoreError(
            404,
            "The exact project create original was not found.",
          );
        if (existing.requestHash !== requestHash)
          throw new ProjectStoreError(
            409,
            "The project create original changed.",
          );
        if (existing.state === "created")
          return { operation: existing, catalog: publicCatalog(store.read()) };
        const snapshot = await createOptions.loadScope();
        const scope = checkedScope(existing.original, snapshot, createOptions);
        const result = await store.commitCreate({
          requestId,
          requestHash,
          reviewedScopeHash,
          currentScopeHash: scope.hash,
        });
        return {
          operation: result.operation,
          catalog: publicCatalog(result.catalog),
        };
      }),
  };
  const retire: ActionRoute<{ requestId: string; requestHash: string }> = {
    kind: "action",
    method: "POST",
    path: "/projects/create-reservations/:requestId/retire",
    action: "project.create.retire",
    validate: retireInput,
    subject: ({ requestId, requestHash }) => ({
      target: requestId,
      family: "project-create",
      requestId,
      inputHash: requestHash,
    }),
    effect: async ({ requestId, requestHash }, context) =>
      reply(async () => {
        if (!context?.auditEventId)
          throw new ProjectStoreError(
            503,
            "The project retirement was not audited.",
          );
        return store.retireCreate(requestId, requestHash);
      }),
  };
  return {
    projects,
    preferences,
    createList,
    createOriginal,
    reserve,
    commit,
    retire,
  };
}
