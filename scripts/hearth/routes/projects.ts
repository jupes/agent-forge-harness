import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { z } from "zod";
import type {
  ProjectCatalog,
  ProjectPreferences,
} from "../../../types/projects";
import { REPOS_FILE, readRepoContext } from "../../beads/repo-context";
import { loadConfig } from "../../config/load";
import { resolveCheckout } from "../../ledger/workspace";
import {
  MAX_PROJECT_CREATE_OPTION_EPICS,
  MAX_PROJECT_CREATE_OPTION_REPOSITORIES,
  MAX_PROJECT_CREATE_OPTIONS_BYTES,
  type ProjectCreateOptions,
  type ProjectScopePreviewQuery,
  projectCreateOptionsSchema,
  projectScopePreviewQuerySchema,
  projectScopePreviewSchema,
} from "../../projects/create-options-protocol";
import {
  projectCreateCommitSchema,
  projectCreateReserveSchema,
  projectCreateRetireSchema,
} from "../../projects/create-protocol";
import {
  createRepositoryOnboarding,
  type RepositoryOnboardingOptions,
} from "../../projects/repository-onboarding";
import {
  type ApprovedRepository,
  approvedRepositorySchema,
} from "../../projects/repository-onboarding-protocol";
import { selectProjectBeads, workspaceKey } from "../../projects/scope";
import {
  createProjectStore,
  hashProjectCreateRequest,
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

const MAX_PROJECT_REPOSITORY_REGISTRY_BYTES = 64 * 1024;

interface PreferenceChange {
  id: string;
  revision: number;
  patch: ProjectPreferences;
}

export interface ProjectCreateRouteOptions {
  root: string;
  workspace: string;
  configHome?: string;
  /** Trusted internal registry source; defaults to the checkout's local state root. */
  projectRepositoryRegistryRoot?: string;
  repositoryOnboarding?: ReturnType<typeof createRepositoryOnboarding>;
  repositoryPickerCommand?: readonly string[];
  repositoryRunGit?: RepositoryOnboardingOptions["runGit"];
  repositoryRunPicker?: RepositoryOnboardingOptions["runPicker"];
  allowLocalRepositoryFixtureUrls?: boolean;
  repositoryManifestRoot?: string;
  loadScope(): Promise<ProjectSnapshot>;
}

function validateConfiguredKeeperSmith(
  name: string,
  options: ProjectCreateRouteOptions,
): void {
  let config: ReturnType<typeof loadConfig>["config"];
  try {
    config = loadConfig({
      harnessRoot: options.root,
      ...(options.configHome !== undefined ? { home: options.configHome } : {}),
      env: {},
    }).config;
  } catch {
    throw new ProjectStoreError(
      503,
      "The configured Keeper Smiths could not be verified. Check configuration before changing projects.",
    );
  }
  const smith = Object.hasOwn(config.smiths, name)
    ? config.smiths[name]
    : undefined;
  if (!smith)
    throw new ProjectStoreError(
      400,
      "The selected Keeper Smith is not configured.",
    );
  if (!smith.enabled)
    throw new ProjectStoreError(400, "The selected Keeper Smith is disabled.");
}

function publicCatalog(catalog: ProjectCatalog) {
  return {
    version: catalog.version,
    revision: catalog.revision,
    projects: catalog.projects,
  };
}

interface ProjectRepositoryOption {
  path: string;
  key: string;
  name: string;
  served: boolean;
}

function unavailableProjectOptions(): ProjectStoreError {
  return new ProjectStoreError(
    503,
    "Complete project setup options are unavailable. Refresh before continuing.",
  );
}

function errorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("code" in error))
    return null;
  return typeof error.code === "string" ? error.code : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Build a complete bounded repository choice list. The served checkout is
 * always available; a present registration file is all-or-nothing so a
 * malformed or missing registered checkout cannot be mistaken for an empty
 * registry.
 */
function completeRepositoryOptions(
  root: string,
  registryRoot?: string,
  approved: readonly ApprovedRepository[] = [],
): ProjectRepositoryOption[] {
  const served = resolveCheckout(root).workspace;
  const servedOption: ProjectRepositoryOption = {
    path: served,
    key: workspaceKey(served),
    name: basename(served),
    served: true,
  };
  const local = registryRoot ?? localStateRoot(root);
  const repositoryRoot = join(local, "repos");
  try {
    const repositoryRootStat = lstatSync(repositoryRoot);
    if (
      repositoryRootStat.isSymbolicLink() ||
      !repositoryRootStat.isDirectory()
    )
      throw unavailableProjectOptions();
  } catch (error) {
    if (error instanceof ProjectStoreError) throw error;
    if (errorCode(error) !== "ENOENT") throw unavailableProjectOptions();
  }
  const registryPath = join(local, REPOS_FILE);
  let registryStat: ReturnType<typeof lstatSync>;
  try {
    registryStat = lstatSync(registryPath);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return [servedOption];
    throw unavailableProjectOptions();
  }
  if (
    registryStat.isSymbolicLink() ||
    !registryStat.isFile() ||
    registryStat.size > MAX_PROJECT_REPOSITORY_REGISTRY_BYTES
  )
    throw unavailableProjectOptions();

  let parsed: unknown;
  try {
    const text = readFileSync(registryPath, "utf8");
    const afterRead = lstatSync(registryPath);
    if (Buffer.byteLength(text, "utf8") > MAX_PROJECT_REPOSITORY_REGISTRY_BYTES)
      throw unavailableProjectOptions();
    if (
      afterRead.isSymbolicLink() ||
      !afterRead.isFile() ||
      afterRead.dev !== registryStat.dev ||
      afterRead.ino !== registryStat.ino ||
      afterRead.size !== registryStat.size ||
      afterRead.mtimeMs !== registryStat.mtimeMs
    )
      throw unavailableProjectOptions();
    parsed = JSON.parse(text);
  } catch {
    throw unavailableProjectOptions();
  }
  if (
    !isRecord(parsed) ||
    Object.keys(parsed).length !== 1 ||
    !Array.isArray(parsed["repos"])
  )
    throw unavailableProjectOptions();
  const entries: unknown[] = parsed["repos"];
  const allowedFields = new Set(["name", "url", "defaultBranch", "archived"]);
  if (
    entries.length + 1 > MAX_PROJECT_CREATE_OPTION_REPOSITORIES ||
    entries.some((entry) => {
      if (!isRecord(entry)) return true;
      if (Object.keys(entry).some((key) => !allowedFields.has(key)))
        return true;
      return (
        typeof entry["name"] !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(entry["name"]) ||
        entry["name"] === "." ||
        entry["name"] === ".." ||
        (entry["url"] !== undefined && typeof entry["url"] !== "string") ||
        (entry["defaultBranch"] !== undefined &&
          typeof entry["defaultBranch"] !== "string") ||
        (entry["archived"] !== undefined &&
          typeof entry["archived"] !== "boolean")
      );
    })
  )
    throw unavailableProjectOptions();

  const options = [servedOption];
  const names = new Set([servedOption.name.toLowerCase()]);
  const keys = new Set([servedOption.key]);
  for (const entry of entries) {
    if (!isRecord(entry) || typeof entry["name"] !== "string")
      throw unavailableProjectOptions();
    const name = entry["name"];
    if (names.has(name.toLowerCase())) throw unavailableProjectOptions();
    names.add(name.toLowerCase());
    const path = join(local, "repos", name);
    let repositoryStat: ReturnType<typeof lstatSync>;
    let gitStat: ReturnType<typeof lstatSync>;
    try {
      repositoryStat = lstatSync(path);
      gitStat = lstatSync(join(path, ".git"));
    } catch {
      throw unavailableProjectOptions();
    }
    if (
      repositoryStat.isSymbolicLink() ||
      !repositoryStat.isDirectory() ||
      gitStat.isSymbolicLink() ||
      (!gitStat.isDirectory() && !gitStat.isFile())
    )
      throw unavailableProjectOptions();
    let canonical: string;
    try {
      canonical = resolveCheckout(path).worktree;
    } catch {
      throw unavailableProjectOptions();
    }
    const key = workspaceKey(canonical);
    if (keys.has(key)) throw unavailableProjectOptions();
    keys.add(key);
    options.push({ path: canonical, key, name, served: false });
  }
  for (const entry of approved) {
    const checked = approvedRepositorySchema.safeParse(entry);
    if (
      !checked.success ||
      options.length >= MAX_PROJECT_CREATE_OPTION_REPOSITORIES
    )
      throw unavailableProjectOptions();
    const approvedEntry = checked.data;
    let canonical: string;
    try {
      canonical = canonicalRepositoryPath(approvedEntry.path);
    } catch {
      throw unavailableProjectOptions();
    }
    const key = workspaceKey(canonical);
    if (
      key !== approvedEntry.key ||
      keys.has(key) ||
      options.some(
        (option) =>
          option.name.toLowerCase() === approvedEntry.name.toLowerCase(),
      )
    )
      throw unavailableProjectOptions();
    keys.add(key);
    options.push({
      path: canonical,
      key,
      name: approvedEntry.name,
      served: false,
    });
  }
  return options;
}

function canonicalRepositoryPath(path: string): string {
  const directory = lstatSync(path);
  const git = lstatSync(join(path, ".git"));
  if (
    directory.isSymbolicLink() ||
    !directory.isDirectory() ||
    git.isSymbolicLink() ||
    (!git.isDirectory() && !git.isFile())
  )
    throw new Error("Repository path is not a Git checkout.");
  const canonical = resolveCheckout(path).worktree;
  const root = resolve(path);
  if (workspaceKey(canonical) !== workspaceKey(root))
    throw new Error("Repository path is not canonical.");
  return canonical;
}

function projectCreateOptionsData(
  snapshot: ProjectSnapshot,
  options: ProjectCreateRouteOptions,
): ProjectCreateOptions {
  const served = resolveCheckout(options.root).workspace;
  const servedKey = workspaceKey(served);
  if (
    workspaceKey(options.workspace) !== servedKey ||
    workspaceKey(snapshot.source.workspace) !== servedKey ||
    snapshot.source.issues === null
  )
    throw unavailableProjectOptions();
  const epics = snapshot.source.issues
    .filter((issue) => issue.type === "epic")
    .map((issue) => ({
      id: issue.id,
      title: issue.title,
      parentId: issue.parent ?? null,
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  const repositoryOptions = completeRepositoryOptions(
    options.root,
    options.projectRepositoryRegistryRoot,
    options.repositoryOnboarding?.approvedRepositories(),
  );
  if (epics.length > MAX_PROJECT_CREATE_OPTION_EPICS)
    throw unavailableProjectOptions();
  const checked = projectCreateOptionsSchema.safeParse({
    complete: true,
    workspace: { path: served, key: servedKey },
    repositories: repositoryOptions,
    epics,
  });
  if (!checked.success) throw unavailableProjectOptions();
  if (
    Buffer.byteLength(JSON.stringify(checked.data), "utf8") >
    MAX_PROJECT_CREATE_OPTIONS_BYTES
  )
    throw unavailableProjectOptions();
  return checked.data;
}

function projectScopePreviewInput(
  request: RouteRequest,
): ValidationResult<ProjectScopePreviewQuery> {
  const allowed = new Set(["slug", "epicId"]);
  for (const name of request.query.keys())
    if (!allowed.has(name)) return fail("The scope preview query is invalid.");
  const slugs = request.query.getAll("slug");
  const parsed = projectScopePreviewQuerySchema.safeParse({
    slug: slugs[0],
    epicIds: request.query.getAll("epicId"),
  });
  if (slugs.length !== 1 || !parsed.success)
    return fail("The scope preview query is invalid.");
  return { ok: true, value: parsed.data };
}

function registeredRepositoryOptions(
  root: string,
  registryRoot?: string,
): Set<string> {
  const allowed = new Set([workspaceKey(resolveCheckout(root).workspace)]);
  const local = registryRoot ?? localStateRoot(root);
  for (const name of readRepoContext(root, registryRoot).context?.knownRepos ??
    []) {
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
  const allowedRepositories = new Set(
    completeRepositoryOptions(
      options.root,
      options.projectRepositoryRegistryRoot,
      options.repositoryOnboarding?.approvedRepositories(),
    ).map((repository) => repository.key),
  );
  if (
    scope.repositories.some(
      (repository) => !allowedRepositories.has(workspaceKey(repository)),
    )
  )
    throw new ProjectStoreError(
      400,
      "Choose only the served checkout or a registered repository.",
    );
  const canonicalRepositories = scope.repositories.map(
    (repository) => resolveCheckout(repository).workspace,
  );
  if (new Set(canonicalRepositories).size !== canonicalRepositories.length)
    throw new ProjectStoreError(
      400,
      "Choose each canonical project repository only once.",
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
  status: number | (() => number) = 200,
): Promise<RouteReply> {
  try {
    const data = await work();
    return {
      status: typeof status === "function" ? status() : status,
      data,
    };
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
  const repositoryOnboarding =
    createOptions.repositoryOnboarding ??
    createRepositoryOnboarding({
      home,
      workspace: createOptions.workspace,
      registryRoot:
        createOptions.repositoryManifestRoot ??
        join(home, "project-create-registry"),
      legacyRegistryRoot:
        createOptions.projectRepositoryRegistryRoot ??
        localStateRoot(createOptions.root),
      ...(createOptions.repositoryPickerCommand === undefined
        ? {}
        : { pickerCommand: createOptions.repositoryPickerCommand }),
      ...(createOptions.repositoryRunGit === undefined
        ? {}
        : { runGit: createOptions.repositoryRunGit }),
      ...(createOptions.repositoryRunPicker === undefined
        ? {}
        : { runPicker: createOptions.repositoryRunPicker }),
      ...(createOptions.allowLocalRepositoryFixtureUrls === undefined
        ? {}
        : {
            allowLocalFixtureUrls:
              createOptions.allowLocalRepositoryFixtureUrls,
          }),
    });
  const pickerInput = (
    request: RouteRequest,
  ): ValidationResult<{ requestId: string }> => {
    const parsed = z
      .object({ requestId: z.string().uuid() })
      .strict()
      .safeParse(request.body);
    return parsed.success
      ? { ok: true, value: parsed.data }
      : fail("Expected a repository selection id.");
  };
  const nameInput = (
    request: RouteRequest,
  ): ValidationResult<{ name: string }> => {
    const parsed = z
      .object({
        name: z
          .string()
          .min(1)
          .max(80)
          .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
      })
      .strict()
      .safeParse(request.body);
    return parsed.success
      ? { ok: true, value: parsed.data }
      : fail("Expected a safe repository name.");
  };
  const cloneReservationInput = (
    request: RouteRequest,
  ): ValidationResult<{ requestId: string; name: string; url: string }> => {
    const parsed = z
      .object({
        requestId: z.string().uuid(),
        name: z.string().min(1).max(80),
        url: z.string().min(1).max(2048),
      })
      .strict()
      .safeParse(request.body);
    return parsed.success
      ? { ok: true, value: parsed.data }
      : fail("Expected a repository clone review.");
  };
  const repositorySelectionRead: ReadRoute<{ requestId: string }> = {
    kind: "read",
    method: "GET",
    path: "/projects/repository-selections/:requestId",
    operatorOnly: true,
    validate: readIdentity,
    read: ({ requestId }) =>
      reply(() => {
        const selection = repositoryOnboarding.getSelection(requestId);
        if (!selection)
          throw new ProjectStoreError(
            404,
            "The exact repository selection was not found.",
          );
        return selection;
      }),
  };
  const repositoryCloneRead: ReadRoute<{ requestId: string }> = {
    kind: "read",
    method: "GET",
    path: "/projects/repository-clone-reservations/:requestId",
    operatorOnly: true,
    validate: readIdentity,
    read: ({ requestId }) =>
      reply(() => {
        const operation = repositoryOnboarding.getClone(requestId);
        if (!operation)
          throw new ProjectStoreError(
            404,
            "The exact repository clone review was not found.",
          );
        return operation;
      }),
  };
  const pickRepository: ActionRoute<{ requestId: string }> = {
    kind: "action",
    method: "POST",
    path: "/projects/repository-selections",
    action: "project.repository.pick",
    maxBodyBytes: 4096,
    validate: pickerInput,
    subject: ({ requestId }) => ({
      family: "project-repository-selection",
      requestId,
    }),
    effect: async ({ requestId }, context) =>
      reply(async () => {
        if (!context?.auditEventId)
          throw new ProjectStoreError(
            503,
            "The repository selection was not audited.",
          );
        try {
          return await repositoryOnboarding.selectFolder(requestId);
        } catch {
          throw new ProjectStoreError(
            409,
            "The saved folder selection is unavailable; it was not repeated.",
          );
        }
      }),
  };
  const registerRepository: ActionRoute<{ requestId: string; name: string }> = {
    kind: "action",
    method: "POST",
    path: "/projects/repository-selections/:requestId/register",
    action: "project.repository.register",
    maxBodyBytes: 4096,
    validate: (request) => {
      const id = readIdentity(request);
      if (!id.ok) return id;
      const name = nameInput(request);
      return name.ok
        ? { ok: true, value: { ...id.value, ...name.value } }
        : name;
    },
    subject: ({ requestId }) => ({
      family: "project-repository-selection",
      requestId,
    }),
    effect: async ({ requestId, name }, context) =>
      reply(async () => {
        if (!context?.auditEventId)
          throw new ProjectStoreError(
            503,
            "Repository registration was not audited.",
          );
        try {
          return await repositoryOnboarding.registerSelection(requestId, name);
        } catch {
          throw new ProjectStoreError(
            409,
            "The reviewed folder could not be registered. Check the saved selection and trusted repository choices.",
          );
        }
      }),
  };
  const reserveRepositoryClone: ActionRoute<{
    requestId: string;
    name: string;
    url: string;
  }> = {
    kind: "action",
    method: "POST",
    path: "/projects/repository-clone-reservations",
    action: "project.repository.clone.reserve",
    maxBodyBytes: 8192,
    validate: cloneReservationInput,
    subject: ({ requestId }) => ({
      family: "project-repository-clone",
      requestId,
    }),
    effect: async (input, context) =>
      reply(async () => {
        if (!context?.auditEventId)
          throw new ProjectStoreError(
            503,
            "The repository clone review was not audited.",
          );
        try {
          return await repositoryOnboarding.reserveClone(
            input.requestId,
            input.name,
            input.url,
          );
        } catch {
          throw new ProjectStoreError(
            400,
            "The clone review could not be saved. Check the URL, name, and existing request status.",
          );
        }
      }),
  };
  const cloneRepository: ActionRoute<{ requestId: string }> = {
    kind: "action",
    method: "POST",
    path: "/projects/repository-clone-reservations/:requestId/clone",
    action: "project.repository.clone",
    maxBodyBytes: 4096,
    validate: readIdentity,
    subject: ({ requestId }) => ({
      family: "project-repository-clone",
      requestId,
    }),
    effect: async ({ requestId }, context) =>
      reply(async () => {
        if (!context?.auditEventId)
          throw new ProjectStoreError(
            503,
            "The repository clone was not audited.",
          );
        try {
          return await repositoryOnboarding.clone(requestId);
        } catch {
          throw new ProjectStoreError(
            409,
            "The saved clone request is unavailable; no repeat was started.",
          );
        }
      }),
  };
  const registerClonedRepository: ActionRoute<{ requestId: string }> = {
    kind: "action",
    method: "POST",
    path: "/projects/repository-clone-reservations/:requestId/register",
    action: "project.repository.clone.register",
    maxBodyBytes: 4096,
    validate: readIdentity,
    subject: ({ requestId }) => ({
      family: "project-repository-clone",
      requestId,
    }),
    effect: async ({ requestId }, context) =>
      reply(async () => {
        if (!context?.auditEventId)
          throw new ProjectStoreError(
            503,
            "The clone registration was not audited.",
          );
        try {
          return await repositoryOnboarding.registerClone(requestId);
        } catch {
          throw new ProjectStoreError(
            409,
            "Only the exact confirmed clone can be registered. Review its saved status.",
          );
        }
      }),
  };
  const projects: ReadRoute<null> = {
    kind: "read",
    method: "GET",
    path: "/projects",
    validate: noParameters,
    read: () => reply(() => publicCatalog(store.read())),
  };
  const createOptionsRead: ReadRoute<null> = {
    kind: "read",
    method: "GET",
    path: "/projects/create-options",
    operatorOnly: true,
    validate: noParameters,
    read: () =>
      reply(async () =>
        projectCreateOptionsData(
          await createOptions.loadScope(),
          createOptions,
        ),
      ),
  };
  const scopePreview: ReadRoute<ProjectScopePreviewQuery> = {
    kind: "read",
    method: "GET",
    path: "/projects/create-scope-preview",
    operatorOnly: true,
    validate: projectScopePreviewInput,
    read: (query) =>
      reply(async () => {
        const snapshot = await createOptions.loadScope();
        // Keep direct preview reads subject to the same complete source and
        // option bounds as the choices route.
        projectCreateOptionsData(snapshot, createOptions);
        const served = resolveCheckout(createOptions.root).workspace;
        const original = {
          slug: query.slug,
          name: "Scope preview",
          description: "",
          icon: "P",
          workspaces: [
            {
              root: served,
              repositories: [served],
              epicIds: [...query.epicIds].sort(),
            },
          ],
        };
        const proof = checkedScope(original, snapshot, createOptions);
        const result = projectScopePreviewSchema.safeParse({
          complete: true,
          workspaceKey: workspaceKey(served),
          slug: query.slug,
          epicIds: [...query.epicIds].sort(),
          scopeCount: proof.count,
          scopeHash: proof.hash,
        });
        if (!result.success) throw unavailableProjectOptions();
        if (
          Buffer.byteLength(JSON.stringify(result.data), "utf8") >
          MAX_PROJECT_CREATE_OPTIONS_BYTES
        )
          throw unavailableProjectOptions();
        return result.data;
      }),
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
    subject: ({ requestId, expectedCatalogRevision, original }) => ({
      target: original.slug,
      family: "project-create",
      requestId,
      inputHash: hashProjectCreateRequest({
        requestId,
        expectedCatalogRevision,
        original,
      }),
    }),
    effect: async (input, context) => {
      let responseStatus = 201;
      return reply(
        async () => {
          if (!context?.auditEventId)
            throw new ProjectStoreError(
              503,
              "The project reservation was not audited.",
            );
          const existing = store.readCreate(input.requestId);
          const requestHash = hashProjectCreateRequest(input);
          if (existing) {
            if (existing.requestHash !== requestHash)
              throw new ProjectStoreError(
                409,
                "This project create UUID is already bound to another original.",
              );
            responseStatus = 200;
            return existing;
          }
          const preflightScope = checkedScope(
            input.original,
            await createOptions.loadScope(),
            createOptions,
          );
          const result = await store.reserveCreate({
            requestId: input.requestId,
            original: input.original,
            expectedCatalogRevision: input.expectedCatalogRevision,
            preflightScope,
            validateScope: async () =>
              checkedScope(
                input.original,
                await createOptions.loadScope(),
                createOptions,
              ),
            validateKeeperSmith: (name) =>
              validateConfiguredKeeperSmith(name, createOptions),
          });
          if (!result.created) responseStatus = 200;
          return result.operation;
        },
        () => responseStatus,
      );
    },
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
        const preflightScope = checkedScope(
          existing.original,
          await createOptions.loadScope(),
          createOptions,
        );
        const result = await store.commitCreate({
          requestId,
          requestHash,
          reviewedScopeHash,
          preflightScope,
          validateScope: async () =>
            checkedScope(
              existing.original,
              await createOptions.loadScope(),
              createOptions,
            ),
          validateKeeperSmith: (name) =>
            validateConfiguredKeeperSmith(name, createOptions),
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
    createOptionsRead,
    scopePreview,
    preferences,
    createList,
    createOriginal,
    repositorySelectionRead,
    repositoryCloneRead,
    reserve,
    commit,
    retire,
    pickRepository,
    registerRepository,
    reserveRepositoryClone,
    cloneRepository,
    registerClonedRepository,
  };
}
