import { expect, test } from "bun:test";
import type { ProjectCreateWriteResult } from "../../apps/desktop/src/project-create-api";
import {
  createProjectCreateIdentities,
  PROJECT_CREATE_IDENTITIES,
  projectCreateRequestHash,
} from "../../apps/desktop/src/project-create-identities";
import { createProjectCreateOwner } from "../../apps/desktop/src/project-create-owner";
import { smithsViewSchema } from "../../apps/desktop/src/smiths-protocol";
import type { SmithsView } from "../../types/hearth";
import {
  type ProjectCreateOptions,
  type ProjectScopePreview,
  projectCreateOptionsSchema,
} from "../projects/create-options-protocol";
import {
  type ProjectCreateIdentity,
  type ProjectCreateOriginal,
  type ProjectCreateReserveRequest,
  projectCreateIdentitySchema,
} from "../projects/create-protocol";
import { workspaceKey } from "../projects/scope";

const workspace = "/fixture/project-create-workspace";
const requestId = "ab847e06-4f01-4dd3-a425-47bf9053e006";
const createdProjectId = "project-b5832fa0-7a21-403b-8184-44892f0d8d86";
const original: ProjectCreateOriginal = {
  slug: "onboarding-project",
  name: "Onboarding project",
  description: "A reviewed project original.",
  icon: "P",
  keeperSmith: "Enabled Keeper",
  color: "green",
  workspaces: [
    {
      root: workspace,
      repositories: [workspace],
      epicIds: ["epic-a"],
    },
  ],
};
const options: ProjectCreateOptions = projectCreateOptionsSchema.parse({
  complete: true,
  workspace: { path: workspace, key: workspaceKey(workspace) },
  repositories: [
    {
      path: workspace,
      key: workspaceKey(workspace),
      name: "Trusted workspace",
      served: true,
    },
  ],
  epics: [{ id: "epic-a", title: "Epic A", parentId: null }],
});
const smiths: SmithsView = smithsViewSchema.parse({
  smiths: [
    {
      name: "Enabled Keeper",
      provider: "claude",
      model: "fixture-model",
      effort: "medium",
      enabled: true,
      tags: [],
    },
  ],
  benches: {
    low: [{ smith: "Enabled Keeper", weight: 1 }],
    medium: [{ smith: "Enabled Keeper", weight: 1 }],
    high: [{ smith: "Enabled Keeper", weight: 1 }],
  },
  defaultSmith: "Enabled Keeper",
});
const preview: ProjectScopePreview = {
  complete: true,
  workspaceKey: workspaceKey(workspace),
  slug: original.slug,
  epicIds: ["epic-a"],
  scopeCount: 3,
  scopeHash: "b".repeat(64),
};

function identity(
  request: ProjectCreateReserveRequest,
  requestHash: string,
  state: ProjectCreateIdentity["state"],
): ProjectCreateIdentity {
  return projectCreateIdentitySchema.parse({
    requestId: request.requestId,
    requestHash,
    original: request.original,
    baseRevision: request.expectedCatalogRevision,
    scopeHash: preview.scopeHash,
    scopeCount: preview.scopeCount,
    state,
    projectId: state === "created" ? createdProjectId : null,
    createdRevision: state === "created" ? 5 : null,
    createdAt: "2026-10-27T00:00:00.000Z",
    updatedAt: "2026-10-27T00:00:00.000Z",
  });
}

function fixture(
  reserveResults: ProjectCreateWriteResult<ProjectCreateIdentity>[] = [],
  overrides: {
    options?: () => Promise<ProjectCreateOptions>;
    original?: (
      id: string,
      current: ProjectCreateIdentity,
    ) => Promise<ProjectCreateIdentity> | ProjectCreateIdentity;
    preview?: () => Promise<ProjectScopePreview>;
  } = {},
) {
  const storage = new Map<string, string>();
  const identities = createProjectCreateIdentities({
    workspace,
    storage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
    },
    withLock: async (work) => work(),
  });
  let server: ProjectCreateIdentity | null = null;
  let currentWorkspace: string | null = workspace;
  let nextReserve = 0;
  const writes: Array<{ kind: string; request?: unknown }> = [];
  const row = () =>
    server
      ? {
          requestId: server.requestId,
          requestHash: server.requestHash,
          state: server.state,
          scopeCount: server.scopeCount,
          projectId: server.projectId,
          createdAt: server.createdAt,
          updatedAt: server.updatedAt,
        }
      : null;
  const project = () => ({
    id: createdProjectId,
    slug: original.slug,
    name: original.name,
    description: original.description,
    icon: original.icon,
    workspaces: [
      {
        root: workspace,
        repositories: [workspace],
        epicIds: ["epic-a"],
      },
    ],
    keeperSmith: original.keeperSmith,
    color: original.color,
    pinned: false,
    archived: false,
    createdAt: "2026-10-27T00:00:00.000Z",
    updatedAt: "2026-10-27T00:00:00.000Z",
  });
  const api = {
    async options() {
      return overrides.options ? overrides.options() : options;
    },
    async smiths() {
      return smiths;
    },
    async discovery() {
      return {
        complete: true as const,
        operations: row() ? [row()!] : [],
      };
    },
    async original(id: string) {
      if (!server || server.requestId !== id) throw Error("404");
      return overrides.original
        ? overrides.original(id, structuredClone(server))
        : structuredClone(server);
    },
    async catalog() {
      return {
        revision: server?.state === "created" ? 5 : 4,
        projects: server?.state === "created" ? [project()] : [],
      };
    },
    async preview() {
      return overrides.preview ? overrides.preview() : preview;
    },
    async reserve(request: ProjectCreateReserveRequest, hash: string) {
      writes.push({ kind: "reserve", request: structuredClone(request) });
      const result = reserveResults[nextReserve++];
      if (result) {
        if (result.state === "confirmed") server = result.value;
        return result;
      }
      const reserved = identity(request, hash, "reserved");
      server = reserved;
      return { state: "confirmed" as const, value: reserved };
    },
    async commit(
      id: string,
      hash: string,
    ): Promise<ProjectCreateWriteResult<ProjectCreateIdentity>> {
      writes.push({ kind: "commit", request: { id, hash } });
      if (!server || server.requestId !== id || server.requestHash !== hash)
        return { state: "unknown", message: "Missing fixture original." };
      server = identity(
        {
          requestId: server.requestId,
          expectedCatalogRevision: server.baseRevision,
          original: server.original,
        },
        hash,
        "created",
      );
      return { state: "confirmed", value: structuredClone(server) };
    },
    async retire(
      id: string,
      hash: string,
    ): Promise<ProjectCreateWriteResult<ProjectCreateIdentity>> {
      writes.push({ kind: "retire", request: { id, hash } });
      if (!server || server.requestId !== id || server.requestHash !== hash)
        return { state: "unknown", message: "Missing fixture original." };
      server = identity(
        {
          requestId: server.requestId,
          expectedCatalogRevision: server.baseRevision,
          original: server.original,
        },
        hash,
        "retired-before-create",
      );
      return { state: "confirmed", value: structuredClone(server) };
    },
  };
  const owner = createProjectCreateOwner({
    workspace,
    currentWorkspace: () => currentWorkspace,
    canWrite: () => true,
    identities,
    api,
    mint: () => requestId,
    changed() {},
  });
  const reopen = () =>
    createProjectCreateOwner({
      workspace,
      currentWorkspace: () => currentWorkspace,
      canWrite: () => true,
      identities,
      api,
      mint: () => requestId,
      changed() {},
    });
  return {
    owner,
    identities,
    writes,
    storage,
    reopen,
    setCurrentWorkspace(value: string | null) {
      currentWorkspace = value;
    },
  };
}

test("missing workspace scope fails closed without identity or API reads", async () => {
  let apiReads = 0;
  let storageReads = 0;
  const identities = createProjectCreateIdentities({
    workspace: null,
    storage: {
      getItem() {
        storageReads += 1;
        return null;
      },
      setItem() {
        throw Error("saved metadata must not be written");
      },
    },
    withLock: async (work) => work(),
  });
  const owner = createProjectCreateOwner({
    workspace: null,
    currentWorkspace: () => null,
    canWrite: () => true,
    identities,
    api: {
      async options() {
        apiReads += 1;
        throw Error("unexpected API read");
      },
      async smiths() {
        apiReads += 1;
        throw Error("unexpected API read");
      },
      async discovery() {
        apiReads += 1;
        throw Error("unexpected API read");
      },
      async original() {
        apiReads += 1;
        throw Error("unexpected API read");
      },
      async catalog() {
        apiReads += 1;
        throw Error("unexpected API read");
      },
      async preview() {
        apiReads += 1;
        throw Error("unexpected API read");
      },
      async reserve() {
        apiReads += 1;
        throw Error("unexpected API write");
      },
      async commit() {
        apiReads += 1;
        throw Error("unexpected API write");
      },
      async retire() {
        apiReads += 1;
        throw Error("unexpected API write");
      },
    },
    mint: () => requestId,
    changed() {},
  });

  await owner.recover();

  expect(owner.get()).toMatchObject({ phase: "unavailable", entries: [] });
  expect(apiReads).toBe(0);
  expect(storageReads).toBe(0);
  owner.dispose();
});

test("project creation reserves, commits, and opens only the verified exact original", async () => {
  const { owner, writes, identities } = fixture();
  await owner.recover();
  expect(owner.get()).toMatchObject({ phase: "ready", entries: [] });

  const reviewed = await owner.preview(original);
  expect(reviewed).toEqual(preview);
  expect(writes).toEqual([]);

  expect(await owner.reserve(original, reviewed!)).toBe(true);
  await owner.recover();
  const saved = owner.get().entries[0];
  expect(saved).toMatchObject({
    phase: "reserved",
    original,
    identity: { requestId, state: "reserved" },
  });
  expect(writes.map((write) => write.kind)).toEqual(["reserve"]);

  const projectId = await owner.commit(requestId);
  expect(projectId).toBe(createdProjectId);
  expect(writes.map((write) => write.kind)).toEqual(["reserve", "commit"]);
  expect(writes[0]?.request).toMatchObject({ requestId, original });
  expect(identities.list()).toMatchObject([
    { request: { requestId, original }, state: "created" },
  ]);
  owner.dispose();
});

test("concurrent reserve clicks admit only one project reservation", async () => {
  const { owner, writes } = fixture();
  await owner.recover();

  const results = await Promise.all([
    owner.reserve(original, preview),
    owner.reserve(original, preview),
  ]);

  expect(results.filter(Boolean)).toHaveLength(1);
  expect(writes.map((write) => write.kind)).toEqual(["reserve"]);
  owner.dispose();
});

test("a mismatched protected original readback remains held without another write", async () => {
  let returnMismatch = false;
  const { owner, writes } = fixture([], {
    original: (_id, current) =>
      returnMismatch
        ? {
            ...current,
            original: {
              ...current.original,
              name: "Different server original",
            },
          }
        : current,
  });
  await owner.recover();
  expect(await owner.reserve(original, preview)).toBe(true);
  expect(writes.map((write) => write.kind)).toEqual(["reserve"]);

  returnMismatch = true;
  await owner.recover();

  expect(owner.get().entries[0]).toMatchObject({
    phase: "unknown",
    identity: null,
  });
  expect(writes.map((write) => write.kind)).toEqual(["reserve"]);
  owner.dispose();
});

test("a stale recovery read cannot restore ready scope after workspace changes", async () => {
  let finishOptions!: (value: ProjectCreateOptions) => void;
  const pendingOptions = new Promise<ProjectCreateOptions>((resolve) => {
    finishOptions = resolve;
  });
  const { owner, writes, identities, setCurrentWorkspace } = fixture([], {
    options: () => pendingOptions,
  });

  const recovery = owner.recover();
  setCurrentWorkspace("/fixture/other-workspace");
  finishOptions(options);
  await recovery;

  expect(owner.get().phase).toBe("unavailable");
  expect(writes).toEqual([]);
  expect(identities.list()).toEqual([]);
  owner.dispose();
});

test("only a typed pre-send refusal permits explicit same-UUID reservation retry", async () => {
  const { owner, writes, identities } = fixture([
    { state: "not-sent", message: "Operator access is unavailable." },
  ]);
  await owner.recover();
  const reviewed = await owner.preview(original);
  expect(await owner.reserve(original, reviewed!)).toBe(false);
  await owner.recover();
  expect(owner.get().entries[0]).toMatchObject({ phase: "not-sent" });
  const replacement = {
    ...original,
    slug: "replacement-project",
    name: "Replacement project",
  };
  expect(await owner.reserve(replacement, preview)).toBe(false);
  expect(writes).toHaveLength(1);
  expect(await owner.retryReservation(requestId)).toBe(true);
  await owner.recover();

  expect(writes).toHaveLength(2);
  expect(writes.every((write) => write.kind === "reserve")).toBe(true);
  expect(writes[0]?.request).toEqual(writes[1]?.request);
  expect(writes[0]?.request).toMatchObject({ requestId, original });
  expect(owner.get().entries[0]).toMatchObject({
    phase: "reserved",
    identity: { requestId, state: "reserved" },
  });
  expect(identities.list()[0]?.requestHash).toMatch(/^[a-f0-9]{64}$/);
  owner.dispose();
});

test("recovery never retries a saved body whose original hash no longer matches", async () => {
  const { owner, writes, storage, reopen } = fixture([
    { state: "not-sent", message: "Operator access is unavailable." },
  ]);
  await owner.recover();
  const reviewed = await owner.preview(original);
  expect(await owner.reserve(original, reviewed!)).toBe(false);
  await owner.recover();
  expect(owner.get().entries[0]).toMatchObject({ phase: "not-sent" });
  expect(writes).toHaveLength(1);
  owner.dispose();

  const key = PROJECT_CREATE_IDENTITIES;
  const encoded = storage.get(key);
  expect(encoded).toBeDefined();
  let saved: unknown;
  try {
    saved = JSON.parse(encoded!);
  } catch {
    throw Error("The fixture's saved metadata was not valid JSON.");
  }
  if (
    typeof saved !== "object" ||
    saved === null ||
    !Array.isArray((saved as { records?: unknown }).records)
  )
    throw Error("The fixture's saved metadata shape was unexpected.");
  const record = (saved as { records: Array<Record<string, unknown>> })
    .records[0];
  if (!record || typeof record.request !== "object" || record.request === null)
    throw Error("The fixture's saved request was unavailable.");
  const request = record.request as {
    original: ProjectCreateOriginal;
  };
  record.request = {
    ...(record.request as Record<string, unknown>),
    original: { ...request.original, name: "Changed after durable refusal" },
  };
  storage.set(key, JSON.stringify(saved));
  const corruptBytes = storage.get(key);

  const recovered = reopen();
  await recovered.recover();
  expect(recovered.get().entries[0]).toMatchObject({ phase: "unknown" });
  expect(await recovered.retryReservation(requestId)).toBe(false);
  expect(writes).toHaveLength(1);
  expect(storage.get(key)).toBe(corruptBytes);
  recovered.dispose();
});

test("unknown reservation and missing server record never enable another POST", async () => {
  const { owner, writes, identities } = fixture([
    { state: "unknown", message: "The reply was lost." },
  ]);
  await owner.recover();
  const reviewed = await owner.preview(original);
  expect(await owner.reserve(original, reviewed!)).toBe(false);
  await owner.recover();

  expect(owner.get().entries[0]).toMatchObject({ phase: "unknown" });
  expect(await owner.retryReservation(requestId)).toBe(false);
  expect(writes.map((write) => write.kind)).toEqual(["reserve"]);
  expect(identities.list()[0]?.state).toBe("unknown");
  owner.dispose();
});

test("a scope change while preview is pending prevents identity reservation and POST", async () => {
  let finishPreview!: (value: ProjectScopePreview) => void;
  const deferredPreview = new Promise<ProjectScopePreview>((resolve) => {
    finishPreview = resolve;
  });
  const { owner, writes, identities, setCurrentWorkspace } = fixture([], {
    preview: () => deferredPreview,
  });
  await owner.recover();

  const pending = owner.reserve(original, preview);
  setCurrentWorkspace("/fixture/other-workspace");
  finishPreview(preview);

  expect(await pending).toBe(false);
  expect(writes).toEqual([]);
  expect(identities.list()).toEqual([]);
  owner.dispose();
});

test("retirement requires exact protected readback and preserves the tombstone", async () => {
  const { owner, writes, identities } = fixture();
  await owner.recover();
  const reviewed = await owner.preview(original);
  expect(await owner.reserve(original, reviewed!)).toBe(true);
  await owner.recover();

  expect(await owner.retire(requestId)).toBe(true);
  await owner.recover();
  expect(writes.map((write) => write.kind)).toEqual(["reserve", "retire"]);
  expect(owner.get().entries).toEqual([]);
  expect(identities.list()).toMatchObject([
    { request: { requestId, original }, state: "retired" },
  ]);
  owner.dispose();
});

test("the local hash is canonical and binds the exact frozen reservation", async () => {
  const request = {
    requestId,
    expectedCatalogRevision: 4,
    original,
  };
  const reordered = {
    original: {
      color: original.color,
      workspaces: original.workspaces,
      keeperSmith: original.keeperSmith,
      icon: original.icon,
      description: original.description,
      name: original.name,
      slug: original.slug,
    },
    expectedCatalogRevision: 4,
    requestId,
  };
  expect(await projectCreateRequestHash(request)).toBe(
    await projectCreateRequestHash(reordered),
  );
});
