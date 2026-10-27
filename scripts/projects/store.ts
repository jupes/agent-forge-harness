import { createHash, randomUUID } from "node:crypto";
import { isAbsolute, join } from "node:path";
import type {
  NewProject,
  ProjectCatalog,
  ProjectColor,
  ProjectCreateOperation,
  ProjectPreferences,
  ProjectRecord,
  ProjectWorkspace,
} from "../../types/projects";
import { PROJECT_COLOR_IDS } from "../../types/projects";
import { comparableCheckout } from "../forge/runs";
import {
  ensurePrivateHome,
  MAX_HOME_FILE_BYTES,
  readHomeFile,
} from "../hearth/home-guard";
import { writeOwnerOnly } from "../hearth/token";
import { isBeadId } from "../hearth/tracker-write";
import { resolveCheckout } from "../ledger/workspace";
import { withQueueLock } from "../scheduler/queue-lock";
import { MAX_PROJECT_CREATE_OPERATIONS } from "./create-protocol";

export const PROJECT_STORE_VERSION = 1;
export const isProjectId = (value: unknown): value is string =>
  typeof value === "string" &&
  /^project-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
    value,
  );

export class ProjectStoreError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 503,
    message: string,
  ) {
    super(message);
  }
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const keys = (value: Record<string, unknown>, allowed: string[]): boolean =>
  Object.keys(value).every((key) => allowed.includes(key));
const text = (value: unknown, max: number, empty = false): value is string =>
  typeof value === "string" &&
  value.length <= max &&
  (empty || value.trim().length > 0) &&
  [...value].every(
    (character) =>
      character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127,
  );
const strings = (
  value: unknown,
  max: number,
  check: (item: unknown) => boolean,
): value is string[] =>
  Array.isArray(value) &&
  value.length > 0 &&
  value.length <= max &&
  value.every(check) &&
  new Set(value).size === value.length;
const absolute = (value: unknown): value is string =>
  text(value, 1024) && isAbsolute(value);
const time = (value: unknown): boolean =>
  typeof value === "string" &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value;
const revision = (value: unknown): value is number =>
  Number.isSafeInteger(value) &&
  typeof value === "number" &&
  value >= 0 &&
  value < Number.MAX_SAFE_INTEGER;
const requestId = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
    value,
  );
const digest = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const projectColor = (value: unknown): value is ProjectColor =>
  typeof value === "string" &&
  PROJECT_COLOR_IDS.some((candidate) => candidate === value);

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (record(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

export function hashProjectCreateRequest(input: {
  requestId: string;
  expectedCatalogRevision: number;
  original: NewProject;
}): string {
  return createHash("sha256")
    .update(
      canonicalJson({
        requestId: input.requestId,
        expectedCatalogRevision: input.expectedCatalogRevision,
        original: input.original,
      }),
    )
    .digest("hex");
}

function validWorkspace(scope: unknown): scope is ProjectWorkspace {
  return (
    record(scope) &&
    keys(scope, ["root", "repositories", "epicIds"]) &&
    absolute(scope["root"]) &&
    strings(scope["repositories"], 32, absolute) &&
    strings(
      scope["epicIds"],
      64,
      (id) => typeof id === "string" && isBeadId(id),
    )
  );
}

function validNew(value: unknown): value is NewProject {
  if (
    !record(value) ||
    !text(value["slug"], 48) ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value["slug"]) ||
    !text(value["name"], 120) ||
    !text(value["description"], 500, true) ||
    !text(value["icon"], 16) ||
    (Object.hasOwn(value, "keeperSmith") &&
      !text(value["keeperSmith"], 1024)) ||
    (Object.hasOwn(value, "color") && !projectColor(value["color"]))
  )
    return false;
  const scopes = value["workspaces"];
  return (
    Array.isArray(scopes) &&
    scopes.length > 0 &&
    scopes.length <= 16 &&
    scopes.every(validWorkspace) &&
    new Set(scopes.map((scope) => comparableCheckout(scope.root))).size ===
      scopes.length
  );
}

function hasUniqueCanonicalRepositories(original: NewProject): boolean {
  return original.workspaces.every((scope) => {
    const repositories = scope.repositories.map(
      (path) => resolveCheckout(path).workspace,
    );
    return new Set(repositories).size === repositories.length;
  });
}

function validProject(value: unknown): value is ProjectRecord {
  return (
    record(value) &&
    keys(value, [
      "id",
      "slug",
      "name",
      "description",
      "icon",
      "workspaces",
      "keeperSmith",
      "color",
      "pinned",
      "archived",
      "createdAt",
      "updatedAt",
    ]) &&
    isProjectId(value["id"]) &&
    typeof value["pinned"] === "boolean" &&
    typeof value["archived"] === "boolean" &&
    time(value["createdAt"]) &&
    time(value["updatedAt"]) &&
    validNew(value)
  );
}

function validCreateOperation(value: unknown): value is ProjectCreateOperation {
  if (
    !record(value) ||
    !keys(value, [
      "requestId",
      "requestHash",
      "original",
      "baseRevision",
      "scopeHash",
      "scopeCount",
      "state",
      "projectId",
      "createdRevision",
      "createdAt",
      "updatedAt",
    ]) ||
    !requestId(value["requestId"]) ||
    !digest(value["requestHash"]) ||
    !validNew(value["original"]) ||
    !keys(value["original"] as Record<string, unknown>, [
      "slug",
      "name",
      "description",
      "icon",
      "workspaces",
      "keeperSmith",
      "color",
    ]) ||
    !revision(value["baseRevision"]) ||
    !digest(value["scopeHash"]) ||
    typeof value["scopeCount"] !== "number" ||
    !Number.isSafeInteger(value["scopeCount"]) ||
    value["scopeCount"] < 0 ||
    value["scopeCount"] > 100_000 ||
    !["reserved", "created", "retired-before-create"].includes(
      String(value["state"]),
    ) ||
    !(value["projectId"] === null || isProjectId(value["projectId"])) ||
    !(
      value["createdRevision"] === null || revision(value["createdRevision"])
    ) ||
    !time(value["createdAt"]) ||
    !time(value["updatedAt"]) ||
    value["requestHash"] !==
      hashProjectCreateRequest({
        requestId: value["requestId"],
        expectedCatalogRevision: value["baseRevision"],
        original: value["original"],
      })
  )
    return false;
  return value["state"] === "created"
    ? value["projectId"] !== null && value["createdRevision"] !== null
    : value["projectId"] === null && value["createdRevision"] === null;
}

/** Invalid/future records refuse the whole catalog; never silently erase a project. */
export function parseProjectCatalog(value: unknown): ProjectCatalog {
  if (
    !record(value) ||
    !keys(value, ["version", "revision", "projects", "createOperations"]) ||
    value["version"] !== PROJECT_STORE_VERSION ||
    !revision(value["revision"]) ||
    !Array.isArray(value["projects"]) ||
    value["projects"].length > 100 ||
    !value["projects"].every(validProject) ||
    (value["createOperations"] !== undefined &&
      (!Array.isArray(value["createOperations"]) ||
        value["createOperations"].length > MAX_PROJECT_CREATE_OPERATIONS ||
        !value["createOperations"].every(validCreateOperation)))
  ) {
    throw new ProjectStoreError(
      503,
      "The project catalog is unreadable or uses an unsupported version. Restore a valid version-1 catalog before changing projects.",
    );
  }
  const projects = value["projects"];
  if (
    new Set(projects.map((item) => item.id)).size !== projects.length ||
    new Set(projects.map((item) => item.slug)).size !== projects.length
  )
    throw new ProjectStoreError(
      503,
      "The project catalog has repeated ids or slugs. Repair it before changing projects.",
    );
  const operations = value["createOperations"] as
    | ProjectCreateOperation[]
    | undefined;
  const currentRevision = value["revision"] as number;
  if (
    operations &&
    (new Set(operations.map((item) => item.requestId)).size !==
      operations.length ||
      operations.some((item) => {
        if (item.baseRevision > currentRevision) return true;
        if (item.state !== "created") return false;
        if (
          item.createdRevision === null ||
          item.createdRevision <= item.baseRevision ||
          item.createdRevision > currentRevision
        )
          return true;
        return !projects.some((project) => {
          const originalScope = item.original.workspaces[0];
          const createdScope = project.workspaces[0];
          return (
            project.id === item.projectId &&
            project.slug === item.original.slug &&
            project.name === item.original.name &&
            project.description === item.original.description &&
            project.icon === item.original.icon &&
            Object.hasOwn(project, "keeperSmith") ===
              Object.hasOwn(item.original, "keeperSmith") &&
            project.keeperSmith === item.original.keeperSmith &&
            Object.hasOwn(project, "color") ===
              Object.hasOwn(item.original, "color") &&
            project.color === item.original.color &&
            originalScope !== undefined &&
            createdScope !== undefined &&
            comparableCheckout(createdScope.root) ===
              comparableCheckout(originalScope.root) &&
            JSON.stringify(
              createdScope.repositories.map(comparableCheckout).sort(),
            ) ===
              JSON.stringify(
                originalScope.repositories.map(comparableCheckout).sort(),
              ) &&
            JSON.stringify(createdScope.epicIds.slice().sort()) ===
              JSON.stringify(originalScope.epicIds.slice().sort())
          );
        });
      }))
  )
    throw new ProjectStoreError(
      503,
      "The project create identity ledger does not match the catalog. Restore a valid catalog before changing projects.",
    );
  return {
    version: 1,
    revision: value["revision"],
    projects,
    ...(operations !== undefined ? { createOperations: operations } : {}),
  };
}

export function projectCatalogPath(home: string): string {
  return join(home, "projects", "catalog.json");
}

/** One machine catalog above workspaces; catalog reads never inspect workspace paths. */
export function createProjectStore(
  home: string,
  now: () => Date = () => new Date(),
) {
  const file = projectCatalogPath(home);
  const read = (): ProjectCatalog => {
    const found = readHomeFile(home, file);
    if (found.problem !== null)
      throw new ProjectStoreError(
        503,
        "The private project catalog could not be read. Check the hearth home permissions before changing projects.",
      );
    if (found.text === null) return { version: 1, revision: 0, projects: [] };
    let value: unknown;
    try {
      value = JSON.parse(found.text);
    } catch {
      throw new ProjectStoreError(
        503,
        "The project catalog is not valid JSON. Restore it before changing projects.",
      );
    }
    return parseProjectCatalog(value);
  };
  const change = async (
    expectedRevision: number,
    update: (catalog: ProjectCatalog) => Partial<ProjectCatalog>,
  ): Promise<ProjectCatalog> => {
    if (!revision(expectedRevision))
      throw new ProjectStoreError(400, "Expected a project catalog revision.");
    ensurePrivateHome(home);
    const result = await withQueueLock(
      join(home, "projects", "write.lock.db"),
      async () => {
        const catalog = read();
        if (catalog.revision !== expectedRevision)
          throw new ProjectStoreError(
            409,
            "Projects changed in another window. Read the catalog again before changing it.",
          );
        const next = parseProjectCatalog({
          version: 1,
          revision: catalog.revision + 1,
          ...update(catalog),
        });
        writeCatalog(next);
        return next;
      },
      { waitMs: 1000 },
    );
    if (!result.ok)
      throw new ProjectStoreError(
        503,
        "Another project change is busy or the project write lock is unavailable. Read projects again before retrying.",
      );
    return result.value;
  };

  const metadataChange = async (
    update: (catalog: ProjectCatalog) => Promise<ProjectCatalog>,
  ): Promise<ProjectCatalog> => {
    ensurePrivateHome(home);
    const result = await withQueueLock(
      join(home, "projects", "write.lock.db"),
      async () => {
        const catalog = read();
        const next = parseProjectCatalog(await update(catalog));
        if (serialize(next) === serialize(catalog)) return read();
        writeCatalog(next);
        const confirmed = read();
        if (serialize(confirmed) !== serialize(next))
          throw new ProjectStoreError(
            503,
            "The project catalog write could not be confirmed. Read the exact create identity before continuing.",
          );
        return confirmed;
      },
      { waitMs: 1000 },
    );
    if (!result.ok)
      throw new ProjectStoreError(
        503,
        "Another project change is busy or the project write lock is unavailable. Read projects again before retrying.",
      );
    return result.value;
  };

  const createRecord = (
    original: NewProject,
    id: string,
    stamp: string,
  ): ProjectRecord => {
    const { color, keeperSmith, ...fields } = original;
    const workspaces = original.workspaces.map((scope) => ({
      root: resolveCheckout(scope.root).workspace,
      repositories: [
        ...new Set(
          scope.repositories.map((path) => resolveCheckout(path).workspace),
        ),
      ],
      epicIds: [...scope.epicIds],
    }));
    return {
      ...fields,
      ...(keeperSmith !== undefined ? { keeperSmith } : {}),
      ...(color !== undefined ? { color } : {}),
      workspaces,
      id,
      pinned: false,
      archived: false,
      createdAt: stamp,
      updatedAt: stamp,
    };
  };

  const writeCatalog = (catalog: ProjectCatalog): void => {
    const content = serialize(catalog);
    if (Buffer.byteLength(content) > MAX_HOME_FILE_BYTES)
      throw new ProjectStoreError(
        400,
        "The project catalog is full; this change was not written.",
      );
    writeOwnerOnly(file, content);
  };

  const serialize = (catalog: ProjectCatalog): string =>
    `${JSON.stringify(catalog, null, 2)}\n`;

  const exactOperation = (catalog: ProjectCatalog, id: string) =>
    catalog.createOperations?.find((item) => item.requestId === id) ?? null;

  const projectedCatalog = (
    catalog: ProjectCatalog,
    operations: ProjectCreateOperation[],
    projects = catalog.projects,
    nextRevision = catalog.revision,
  ): ProjectCatalog => ({
    version: 1,
    revision: nextRevision,
    projects,
    createOperations: operations,
  });

  return {
    read,
    /** Trusted producer seam for onboarding. No creation API or UI is exposed here. */
    async create(
      input: NewProject,
      expectedRevision: number,
    ): Promise<ProjectCatalog> {
      if (
        !validNew(input) ||
        !keys(input, [
          "slug",
          "name",
          "description",
          "icon",
          "workspaces",
          "keeperSmith",
          "color",
        ])
      )
        throw new ProjectStoreError(
          400,
          "A project needs a name, slug, icon and explicit workspace, repository and epic scope.",
        );
      // Resolve only the explicitly supplied paths when the trusted producer creates a record.
      const workspaces = input.workspaces.map((scope) => ({
        root: resolveCheckout(scope.root).workspace,
        repositories: [
          ...new Set(
            scope.repositories.map((path) => resolveCheckout(path).workspace),
          ),
        ],
        epicIds: [...scope.epicIds],
      }));
      return change(expectedRevision, (catalog) => ({
        projects: (() => {
          if (catalog.projects.some((item) => item.slug === input.slug))
            throw new ProjectStoreError(
              409,
              "A project already uses that slug. Choose another slug.",
            );
          const stamp = now().toISOString();
          return [
            ...catalog.projects,
            createRecord(
              { ...input, workspaces },
              `project-${randomUUID()}`,
              stamp,
            ),
          ];
        })(),
        ...(catalog.createOperations
          ? { createOperations: catalog.createOperations }
          : {}),
      }));
    },
    async preferences(
      id: string,
      expectedRevision: number,
      patch: ProjectPreferences,
    ): Promise<ProjectCatalog> {
      if (
        !isProjectId(id) ||
        !record(patch) ||
        !keys(patch, ["pinned", "archived"]) ||
        Object.keys(patch).length === 0 ||
        Object.values(patch).some((value) => typeof value !== "boolean")
      )
        throw new ProjectStoreError(
          400,
          "Expected a project id and boolean pin or archive preference.",
        );
      return change(expectedRevision, (catalog) => ({
        projects: (() => {
          if (!catalog.projects.some((item) => item.id === id))
            throw new ProjectStoreError(
              404,
              "This project is no longer in the catalog. Choose a project again.",
            );
          return catalog.projects.map((item) =>
            item.id === id
              ? { ...item, ...patch, updatedAt: now().toISOString() }
              : item,
          );
        })(),
        ...(catalog.createOperations
          ? { createOperations: catalog.createOperations }
          : {}),
      }));
    },
    readCreate(requestId: string): ProjectCreateOperation | null {
      if (!requestId || !/^[0-9a-f-]{36}$/.test(requestId)) return null;
      return exactOperation(read(), requestId);
    },
    listCreates(): ProjectCreateOperation[] {
      return [...(read().createOperations ?? [])];
    },
    async reserveCreate(input: {
      requestId: string;
      original: NewProject;
      expectedCatalogRevision: number;
      preflightScope: { hash: string; count: number };
      validateScope(): Promise<{ hash: string; count: number }>;
      validateKeeperSmith?(name: string): void;
    }): Promise<{
      catalog: ProjectCatalog;
      operation: ProjectCreateOperation;
      created: boolean;
    }> {
      if (
        !requestId(input.requestId) ||
        !validNew(input.original) ||
        !keys(input.original, [
          "slug",
          "name",
          "description",
          "icon",
          "workspaces",
          "keeperSmith",
          "color",
        ]) ||
        !revision(input.expectedCatalogRevision) ||
        !digest(input.preflightScope?.hash) ||
        !Number.isSafeInteger(input.preflightScope?.count) ||
        input.preflightScope.count < 0 ||
        input.preflightScope.count > 100_000 ||
        typeof input.validateScope !== "function"
      )
        throw new ProjectStoreError(
          400,
          "Expected a bounded project create original.",
        );
      const requestHash = hashProjectCreateRequest(input);
      const existing = exactOperation(read(), input.requestId);
      if (existing) {
        if (existing.requestHash !== requestHash)
          throw new ProjectStoreError(
            409,
            "This project create UUID is already bound to a different original.",
          );
        return { catalog: read(), operation: existing, created: false };
      }
      if (!hasUniqueCanonicalRepositories(input.original))
        throw new ProjectStoreError(
          400,
          "Choose each canonical project repository only once.",
        );
      const stamp = now().toISOString();
      let operation: ProjectCreateOperation | null = null;
      let created = false;
      const catalog = await metadataChange(async (current) => {
        const raced = exactOperation(current, input.requestId);
        if (raced) {
          if (raced.requestHash !== requestHash)
            throw new ProjectStoreError(
              409,
              "This project create UUID is already bound to a different original.",
            );
          operation = raced;
          created = false;
          return current;
        }
        if (current.revision !== input.expectedCatalogRevision)
          throw new ProjectStoreError(
            409,
            "Projects changed. Read the catalog and review this create again.",
          );
        if (current.projects.some((item) => item.slug === input.original.slug))
          throw new ProjectStoreError(
            409,
            "A project already uses that slug. Choose another name.",
          );
        const operations = current.createOperations ?? [];
        if (
          operations.some(
            (item) =>
              item.state === "reserved" &&
              item.original.slug === input.original.slug,
          )
        )
          throw new ProjectStoreError(
            409,
            "Another project with that slug is already reserved.",
          );
        if (!hasUniqueCanonicalRepositories(input.original))
          throw new ProjectStoreError(
            400,
            "Choose each canonical project repository only once.",
          );
        if (input.original.keeperSmith !== undefined)
          input.validateKeeperSmith?.(input.original.keeperSmith);
        const scope = await input.validateScope();
        if (
          !digest(scope.hash) ||
          !Number.isSafeInteger(scope.count) ||
          scope.count < 0 ||
          scope.count > 100_000
        )
          throw new ProjectStoreError(
            503,
            "The complete project source could not be verified. Refresh before reserving this project.",
          );
        if (
          scope.hash !== input.preflightScope.hash ||
          scope.count !== input.preflightScope.count
        )
          throw new ProjectStoreError(
            409,
            "The project source changed while reserving. Refresh and review the complete scope again.",
          );
        if (operations.length >= MAX_PROJECT_CREATE_OPERATIONS)
          throw new ProjectStoreError(
            503,
            "The bounded project create identity ledger is full; no reservation was written.",
          );
        operation = {
          requestId: input.requestId,
          requestHash,
          original: input.original,
          baseRevision: current.revision,
          scopeHash: scope.hash,
          scopeCount: scope.count,
          state: "reserved",
          projectId: null,
          createdRevision: null,
          createdAt: stamp,
          updatedAt: stamp,
        };
        created = true;
        const reservedOperations = [...operations, operation];
        const reserved = projectedCatalog(current, reservedOperations);
        const project = createRecord(
          input.original,
          "project-00000000-0000-4000-8000-000000000000",
          stamp,
        );
        const completed = {
          ...operation,
          state: "created" as const,
          projectId: project.id,
          createdRevision: current.revision + 1,
        };
        const projected = projectedCatalog(
          current,
          [...operations, completed],
          [...current.projects, project],
          current.revision + 1,
        );
        if (
          Buffer.byteLength(serialize(reserved)) > MAX_HOME_FILE_BYTES ||
          Buffer.byteLength(serialize(projected)) > MAX_HOME_FILE_BYTES
        )
          throw new ProjectStoreError(
            400,
            "The project create original and terminal record exceed the bounded catalog size.",
          );
        return reserved;
      });
      if (!operation) operation = exactOperation(catalog, input.requestId);
      if (!operation)
        throw new ProjectStoreError(
          503,
          "The project reservation could not be read back.",
        );
      return { catalog, operation, created };
    },
    async commitCreate(input: {
      requestId: string;
      requestHash: string;
      reviewedScopeHash: string;
      preflightScope: { hash: string; count: number };
      validateScope(): Promise<{ hash: string; count: number }>;
      validateKeeperSmith?(name: string): void;
    }): Promise<{
      catalog: ProjectCatalog;
      operation: ProjectCreateOperation;
    }> {
      if (
        !requestId(input.requestId) ||
        !digest(input.requestHash) ||
        !digest(input.reviewedScopeHash) ||
        !digest(input.preflightScope?.hash) ||
        !Number.isSafeInteger(input.preflightScope?.count) ||
        input.preflightScope.count < 0 ||
        input.preflightScope.count > 100_000 ||
        typeof input.validateScope !== "function"
      )
        throw new ProjectStoreError(
          400,
          "Expected the exact project create reservation.",
        );
      let operation: ProjectCreateOperation | null = null;
      const catalog = await metadataChange(async (current) => {
        const found = exactOperation(current, input.requestId);
        if (!found)
          throw new ProjectStoreError(
            404,
            "The exact project create reservation was not found.",
          );
        if (found.requestHash !== input.requestHash)
          throw new ProjectStoreError(
            409,
            "The project create original changed. No project was created.",
          );
        if (found.state === "created") {
          operation = found;
          return current;
        }
        if (found.state !== "reserved")
          throw new ProjectStoreError(
            409,
            "This project create reservation was retired. Start a new reviewed project only after checking the original.",
          );
        if (!hasUniqueCanonicalRepositories(found.original))
          throw new ProjectStoreError(
            400,
            "The saved project original names the same canonical repository more than once.",
          );
        if (current.revision !== found.baseRevision)
          throw new ProjectStoreError(
            409,
            "The project catalog changed after this reservation. Check the original before continuing.",
          );
        if (current.projects.some((item) => item.slug === found.original.slug))
          throw new ProjectStoreError(
            409,
            "A project already uses that slug. Check the saved original before continuing.",
          );
        if (found.original.keeperSmith !== undefined)
          input.validateKeeperSmith?.(found.original.keeperSmith);
        const scope = await input.validateScope();
        if (
          !digest(scope.hash) ||
          !Number.isSafeInteger(scope.count) ||
          scope.count < 0 ||
          scope.count > 100_000
        )
          throw new ProjectStoreError(
            503,
            "The complete project source could not be verified. Refresh before creating this project.",
          );
        if (
          found.scopeHash !== input.reviewedScopeHash ||
          found.scopeHash !== scope.hash ||
          found.scopeHash !== input.preflightScope.hash ||
          scope.count !== input.preflightScope.count
        )
          throw new ProjectStoreError(
            409,
            "The reviewed project scope changed. Check the saved original before continuing.",
          );
        const stamp = now().toISOString();
        const project = createRecord(
          found.original,
          `project-${randomUUID()}`,
          stamp,
        );
        const created: ProjectCreateOperation = {
          ...found,
          state: "created",
          projectId: project.id,
          createdRevision: current.revision + 1,
          updatedAt: stamp,
        };
        const next: ProjectCatalog = {
          version: 1,
          revision: current.revision + 1,
          projects: [...current.projects, project],
          createOperations: (current.createOperations ?? []).map((item) =>
            item.requestId === found.requestId ? created : item,
          ),
        };
        operation = created;
        return parseProjectCatalog(next);
      });
      if (!operation) operation = exactOperation(catalog, input.requestId);
      if (!operation)
        throw new ProjectStoreError(
          503,
          "The project create receipt could not be read back.",
        );
      const project = operation.projectId
        ? catalog.projects.find((item) => item.id === operation?.projectId)
        : undefined;
      if (operation.state === "created" && !project)
        throw new ProjectStoreError(
          503,
          "The project create receipt has no matching catalog record.",
        );
      return { catalog, operation };
    },
    async retireCreate(
      requestId: string,
      requestHash: string,
    ): Promise<ProjectCreateOperation> {
      let operation: ProjectCreateOperation | null = null;
      const catalog = await metadataChange(async (current) => {
        const found = exactOperation(current, requestId);
        if (!found)
          throw new ProjectStoreError(
            404,
            "The exact project create reservation was not found.",
          );
        if (found.requestHash !== requestHash)
          throw new ProjectStoreError(
            409,
            "The project create original changed. Nothing was retired.",
          );
        if (found.state === "created")
          throw new ProjectStoreError(
            409,
            "A created project cannot be retired as an uncreated reservation.",
          );
        if (found.state === "retired-before-create") {
          operation = found;
          return current;
        }
        const retired: ProjectCreateOperation = {
          ...found,
          state: "retired-before-create",
          projectId: null,
          createdRevision: null,
          updatedAt: now().toISOString(),
        };
        operation = retired;
        return projectedCatalog(
          current,
          (current.createOperations ?? []).map((item) =>
            item.requestId === requestId ? retired : item,
          ),
        );
      });
      if (!operation) operation = exactOperation(catalog, requestId);
      if (!operation)
        throw new ProjectStoreError(
          503,
          "The project retirement receipt could not be read back.",
        );
      return operation;
    },
  };
}
