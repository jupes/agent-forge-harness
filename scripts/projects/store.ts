import { randomUUID } from "node:crypto";
import { isAbsolute, join } from "node:path";
import type {
  NewProject,
  ProjectCatalog,
  ProjectPreferences,
  ProjectRecord,
  ProjectWorkspace,
} from "../../types/projects";
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
    !text(value["icon"], 16)
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

/** Invalid/future records refuse the whole catalog; never silently erase a project. */
export function parseProjectCatalog(value: unknown): ProjectCatalog {
  if (
    !record(value) ||
    !keys(value, ["version", "revision", "projects"]) ||
    value["version"] !== PROJECT_STORE_VERSION ||
    !revision(value["revision"]) ||
    !Array.isArray(value["projects"]) ||
    value["projects"].length > 100 ||
    !value["projects"].every(validProject)
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
  return { version: 1, revision: value["revision"], projects };
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
    update: (catalog: ProjectCatalog) => ProjectRecord[],
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
          projects: update(catalog),
        });
        const content = `${JSON.stringify(next, null, 2)}\n`;
        if (Buffer.byteLength(content) > MAX_HOME_FILE_BYTES)
          throw new ProjectStoreError(
            400,
            "The project catalog is full; this change was not written.",
          );
        writeOwnerOnly(file, content);
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
  return {
    read,
    /** Trusted producer seam for onboarding. No creation API or UI is exposed here. */
    async create(
      input: NewProject,
      expectedRevision: number,
    ): Promise<ProjectCatalog> {
      if (
        !validNew(input) ||
        !keys(input, ["slug", "name", "description", "icon", "workspaces"])
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
      return change(expectedRevision, (catalog) => {
        if (catalog.projects.some((item) => item.slug === input.slug))
          throw new ProjectStoreError(
            409,
            "A project already uses that slug. Choose another slug.",
          );
        const stamp = now().toISOString();
        return [
          ...catalog.projects,
          {
            ...input,
            workspaces,
            id: `project-${randomUUID()}`,
            pinned: false,
            archived: false,
            createdAt: stamp,
            updatedAt: stamp,
          },
        ];
      });
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
      return change(expectedRevision, (catalog) => {
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
      });
    },
  };
}
