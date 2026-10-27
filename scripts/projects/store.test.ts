import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeOwnerOnly } from "../hearth/token";
import {
  createProjectStore,
  hashProjectCreateRequest,
  projectCatalogPath,
} from "./store";

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function createRequestHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0))
    rmSync(home, { recursive: true, force: true });
});

test("two windows with the same revision cannot overwrite one another", async () => {
  const { home, store, input } = fixture();
  const created = await store.create(input, 0);
  const id = created.projects[0]?.id;
  if (!id) throw new Error("project missing");
  const results = await Promise.allSettled([
    store.preferences(id, 1, { pinned: true }),
    createProjectStore(home).preferences(id, 1, { archived: true }),
  ]);
  expect(results.map((result) => result.status).sort()).toEqual([
    "fulfilled",
    "rejected",
  ]);
  const rejected = results.find((result) => result.status === "rejected");
  expect(rejected?.status === "rejected" ? rejected.reason.status : null).toBe(
    409,
  );
  expect(store.read().revision).toBe(2);
  const current = store.read().projects[0];
  expect(Number(current?.pinned) + Number(current?.archived)).toBe(1);
  await store.preferences(id, 2, { pinned: true, archived: true });
  expect(store.read().projects[0]).toMatchObject({
    id,
    pinned: true,
    archived: true,
  });
});

test("corrupt, future and duplicate catalogs are errors and a write never replaces them", async () => {
  const { home, store, input } = fixture();
  const created = await store.create(input, 0);
  const file = join(home, "projects", "catalog.json");
  for (const content of [
    "{",
    JSON.stringify({ ...created, version: 2 }),
    JSON.stringify({
      ...created,
      projects: [...created.projects, ...created.projects],
    }),
  ]) {
    writeOwnerOnly(file, content);
    expect(() => store.read()).toThrow();
    await expect(store.create({ ...input, slug: "beta" }, 1)).rejects.toThrow();
    expect(readFileSync(file, "utf8")).toBe(content);
  }
});

test("an unreadable catalog is not a first-run empty catalog", () => {
  const { home, store } = fixture();
  mkdirSync(join(home, "projects", "catalog.json"), { recursive: true });
  expect(() => store.read()).toThrow();
});

test("stable slugs are unique and invalid producer input changes nothing", async () => {
  const { store, input } = fixture();
  const created = await store.create(input, 0);
  await expect(
    store.create({ ...input, name: "Renamed display" }, 1),
  ).rejects.toThrow("slug");
  await expect(store.create({ ...input, workspaces: [] }, 1)).rejects.toThrow(
    "scope",
  );
  await expect(
    store.create({ ...input, slug: "../escape" }, 1),
  ).rejects.toThrow();
  expect(store.read()).toEqual(created);
});

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "forge-projects-"));
  homes.push(home);
  const store = createProjectStore(home);
  const input = {
    slug: "alpha",
    name: "Alpha",
    description: "A scoped project",
    icon: "A",
    workspaces: [{ root: home, repositories: [home], epicIds: ["demo-epic"] }],
  };
  return { home, store, input };
}

test("a project survives reopening with stable identity and revision-checked preferences", async () => {
  const { home, store, input } = fixture();
  expect(store.read()).toEqual({ version: 1, revision: 0, projects: [] });
  const created = await store.create(input, 0);
  expect(created.revision).toBe(1);
  const project = created.projects[0];
  expect(project?.id).toMatch(/^project-[0-9a-f-]{36}$/);
  if (!project) throw new Error("project missing");
  const reopened = createProjectStore(home);
  expect(reopened.read()).toEqual(created);
  const updated = await reopened.preferences(project.id, 1, {
    pinned: true,
    archived: true,
  });
  expect(updated.revision).toBe(2);
  expect(updated.projects[0]).toMatchObject({
    ...project,
    pinned: true,
    archived: true,
    updatedAt: expect.any(String),
  });
  expect(createProjectStore(home).read()).toEqual(updated);
});

test("create identity hashes bind the UUID and expected semantic revision", async () => {
  const { store, input } = fixture();
  const firstId = "cf2ca2e2-a2d1-42bb-b9b4-1517c3db434e";
  const first = await store.reserveCreate({
    requestId: firstId,
    original: input,
    expectedCatalogRevision: 0,
    preflightScope: { hash: "a".repeat(64), count: 0 },
    validateScope: async () => ({ hash: "a".repeat(64), count: 0 }),
  });
  expect(first.created).toBe(true);
  expect(first.operation.requestHash).toBe(
    createRequestHash({
      requestId: firstId,
      expectedCatalogRevision: 0,
      original: input,
    }),
  );
  const hashInput = {
    requestId: firstId,
    expectedCatalogRevision: 0,
    original: input,
    validateScope: async () => ({ hash: "a".repeat(64), count: 0 }),
  };
  expect(hashProjectCreateRequest(hashInput)).toBe(first.operation.requestHash);
  await expect(
    store.reserveCreate({
      requestId: firstId,
      original: input,
      expectedCatalogRevision: 1,
      preflightScope: { hash: "a".repeat(64), count: 0 },
      validateScope: async () => ({ hash: "a".repeat(64), count: 0 }),
    }),
  ).rejects.toMatchObject({ status: 409 });
  const replay = await store.reserveCreate({
    requestId: firstId,
    original: input,
    expectedCatalogRevision: 0,
    preflightScope: { hash: "a".repeat(64), count: 0 },
    validateScope: async () => ({ hash: "a".repeat(64), count: 0 }),
  });
  expect(replay.created).toBe(false);
  expect(replay.operation).toEqual(first.operation);

  await store.retireCreate(firstId, first.operation.requestHash);
  const secondId = "975d7e7a-4694-4b06-995c-b087d7fda3a0";
  const second = await store.reserveCreate({
    requestId: secondId,
    original: input,
    expectedCatalogRevision: 0,
    preflightScope: { hash: "a".repeat(64), count: 0 },
    validateScope: async () => ({ hash: "a".repeat(64), count: 0 }),
  });
  expect(second.operation.requestHash).toBe(
    createRequestHash({
      requestId: secondId,
      expectedCatalogRevision: 0,
      original: input,
    }),
  );
  expect(second.operation.requestHash).not.toBe(first.operation.requestHash);
});

test("an explicit project Keeper Smith is bound to the saved original and committed record while legacy originals stay absent", async () => {
  const { home, store, input } = fixture();
  const requestId = "bba4e479-101f-48c4-bbb8-04f242e3d325";
  const legacyHash = hashProjectCreateRequest({
    requestId,
    expectedCatalogRevision: 0,
    original: input,
  });
  const explicitOriginal = Object.assign({}, input, {
    keeperSmith: "claude-master",
  });
  const explicitHash = hashProjectCreateRequest({
    requestId,
    expectedCatalogRevision: 0,
    original: explicitOriginal,
  });
  expect(explicitHash).not.toBe(legacyHash);

  const reservation = await store.reserveCreate({
    requestId,
    original: explicitOriginal,
    expectedCatalogRevision: 0,
    preflightScope: { hash: "a".repeat(64), count: 0 },
    validateScope: async () => ({ hash: "a".repeat(64), count: 0 }),
  });
  expect(reservation.operation.original).toEqual(explicitOriginal);
  expect(reservation.operation.requestHash).toBe(explicitHash);
  expect(createProjectStore(home).readCreate(requestId)).toEqual(
    reservation.operation,
  );

  const committed = await store.commitCreate({
    requestId,
    requestHash: explicitHash,
    reviewedScopeHash: reservation.operation.scopeHash,
    preflightScope: { hash: reservation.operation.scopeHash, count: 0 },
    validateScope: async () => ({
      hash: reservation.operation.scopeHash,
      count: 0,
    }),
  });
  const committedProject = committed.catalog.projects[0];
  expect(committedProject?.slug).toBe(input.slug);
  expect(
    committedProject && "keeperSmith" in committedProject
      ? committedProject.keeperSmith
      : undefined,
  ).toBe("claude-master");
  const reopenedProject = createProjectStore(home).read().projects[0];
  expect(
    reopenedProject && "keeperSmith" in reopenedProject
      ? reopenedProject.keeperSmith
      : undefined,
  ).toBe("claude-master");
  await expect(
    store.reserveCreate({
      requestId,
      original: Object.assign({}, input, { keeperSmith: "codex-journeyman" }),
      expectedCatalogRevision: 0,
      preflightScope: { hash: "a".repeat(64), count: 0 },
      validateScope: async () => ({ hash: "a".repeat(64), count: 0 }),
    }),
  ).rejects.toMatchObject({ status: 409 });

  const file = projectCatalogPath(home);
  const saved = JSON.parse(readFileSync(file, "utf8")) as {
    projects: Array<Record<string, unknown>>;
  };
  saved.projects[0]!.keeperSmith = "codex-journeyman";
  const corrupted = JSON.stringify(saved);
  writeOwnerOnly(file, corrupted);
  expect(() => store.read()).toThrow();
  expect(readFileSync(file, "utf8")).toBe(corrupted);
});

test("a legacy original commits on the direct store path without a Keeper field", async () => {
  const { store, input } = fixture();
  const requestId = "5e091eab-8a4f-45dc-8fbb-19e9425d5c4e";
  const reservation = await store.reserveCreate({
    requestId,
    original: input,
    expectedCatalogRevision: 0,
    preflightScope: { hash: "c".repeat(64), count: 0 },
    validateScope: async () => ({ hash: "c".repeat(64), count: 0 }),
  });
  const committed = await store.commitCreate({
    requestId,
    requestHash: reservation.operation.requestHash,
    reviewedScopeHash: reservation.operation.scopeHash,
    preflightScope: { hash: reservation.operation.scopeHash, count: 0 },
    validateScope: async () => ({
      hash: reservation.operation.scopeHash,
      count: 0,
    }),
  });
  expect(committed.catalog.projects[0]?.slug).toBe(input.slug);
  expect(
    Object.hasOwn(committed.catalog.projects[0] ?? {}, "keeperSmith"),
  ).toBe(false);
});

test("a legacy project create original remains byte-shape absent of Keeper selection", async () => {
  const { home, store, input } = fixture();
  const requestId = "b780a320-2335-4b04-b5ce-14455ac29335";
  const legacy = await store.reserveCreate({
    requestId,
    original: input,
    expectedCatalogRevision: 0,
    preflightScope: { hash: "b".repeat(64), count: 0 },
    validateScope: async () => ({ hash: "b".repeat(64), count: 0 }),
  });
  const reopened = createProjectStore(home).readCreate(requestId);
  expect(reopened).toEqual(legacy.operation);
  expect(Object.hasOwn(reopened?.original ?? {}, "keeperSmith")).toBe(false);
});

test("project catalog preferences preserve pending create originals without advancing their metadata revision", async () => {
  const { home, store, input } = fixture();
  const existing = await store.create(input, 0);
  const current = existing.projects[0];
  if (!current) throw new Error("project missing");
  const reserved = await store.reserveCreate({
    requestId: "bfefeb99-b4a8-4e6b-b6b1-5916b9d355c1",
    original: { ...input, slug: "beta", name: "Beta" },
    expectedCatalogRevision: 1,
    preflightScope: { hash: "b".repeat(64), count: 3 },
    validateScope: async () => ({ hash: "b".repeat(64), count: 3 }),
  });
  expect(reserved.catalog.revision).toBe(1);
  const updated = await store.preferences(current.id, 1, { pinned: true });
  expect(updated.revision).toBe(2);
  expect(updated.projects[0]).toMatchObject({ id: current.id, pinned: true });
  expect(
    createProjectStore(home).readCreate(reserved.operation.requestId),
  ).toEqual(reserved.operation);
});

test("a project reservation refuses distinct repository spellings of the same canonical checkout", async () => {
  const { store, input } = fixture();
  const separator = process.platform === "win32" ? "\\" : "/";
  const original = {
    ...input,
    workspaces: [
      {
        root: input.workspaces[0]!.root,
        repositories: [
          input.workspaces[0]!.root,
          `${input.workspaces[0]!.root}${separator}`,
        ],
        epicIds: input.workspaces[0]!.epicIds,
      },
    ],
  };
  const before = store.read();
  const requestId = "78ff0894-37dc-457c-b818-11238edb9722";
  await expect(
    store.reserveCreate({
      requestId,
      original,
      expectedCatalogRevision: 0,
      preflightScope: { hash: "a".repeat(64), count: 1 },
      validateScope: async () => ({ hash: "a".repeat(64), count: 1 }),
    }),
  ).rejects.toMatchObject({ status: 400 });
  expect(store.read()).toEqual(before);
  expect(store.readCreate(requestId)).toBeNull();
});

test("project create ledger refuses a reservation that would exceed the catalog byte cap", async () => {
  const { home, store, input } = fixture();
  const catalogFile = projectCatalogPath(home);
  let lastError: unknown;
  for (let index = 0; index < 300; index += 1) {
    const requestId = `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
    try {
      await store.reserveCreate({
        requestId,
        original: {
          ...input,
          slug: `capacity-${index}`,
          name: `Capacity ${index}`,
          description: "x".repeat(450),
        },
        expectedCatalogRevision: 0,
        preflightScope: { hash: "b".repeat(64), count: 1 },
        validateScope: async () => ({ hash: "b".repeat(64), count: 1 }),
      });
    } catch (error) {
      lastError = error;
      break;
    }
  }
  expect(lastError).toMatchObject({ status: 400 });
  const before = readFileSync(catalogFile, "utf8");
  await expect(
    store.reserveCreate({
      requestId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
      original: {
        ...input,
        slug: "capacity-after-full",
        name: "Capacity after full",
        description: "x".repeat(450),
      },
      expectedCatalogRevision: 0,
      preflightScope: { hash: "b".repeat(64), count: 1 },
      validateScope: async () => ({ hash: "b".repeat(64), count: 1 }),
    }),
  ).rejects.toMatchObject({ status: 400 });
  expect(readFileSync(catalogFile, "utf8")).toBe(before);
});

test("concurrent commit and retirement leave one durable terminal outcome", async () => {
  const { store, input } = fixture();
  const requestId = "65b017ba-2f30-4439-a9cc-18a55ff2ed4c";
  const reserved = await store.reserveCreate({
    requestId,
    original: input,
    expectedCatalogRevision: 0,
    preflightScope: { hash: "c".repeat(64), count: 1 },
    validateScope: async () => ({ hash: "c".repeat(64), count: 1 }),
  });
  const outcomes = await Promise.allSettled([
    store.commitCreate({
      requestId,
      requestHash: reserved.operation.requestHash,
      reviewedScopeHash: reserved.operation.scopeHash,
      preflightScope: { hash: reserved.operation.scopeHash, count: 1 },
      validateScope: async () => ({
        hash: reserved.operation.scopeHash,
        count: 1,
      }),
    }),
    store.retireCreate(requestId, reserved.operation.requestHash),
  ]);
  expect(
    outcomes.filter((outcome) => outcome.status === "fulfilled"),
  ).toHaveLength(1);
  expect(
    outcomes.filter((outcome) => outcome.status === "rejected"),
  ).toHaveLength(1);
  const current = store.read();
  const identity = store.readCreate(requestId);
  expect(
    identity?.state === "created" ||
      identity?.state === "retired-before-create",
  ).toBe(true);
  expect(current.projects.length).toBe(identity?.state === "created" ? 1 : 0);
  expect(current.revision).toBe(identity?.state === "created" ? 1 : 0);
});

test("a modified saved create original is a corrupt catalog and is never repaired from elsewhere", async () => {
  const { home, store, input } = fixture();
  const reserved = await store.reserveCreate({
    requestId: "01e1a1bc-36fa-4df3-ae65-d1068d1b97dc",
    original: input,
    expectedCatalogRevision: 0,
    preflightScope: { hash: "f".repeat(64), count: 0 },
    validateScope: async () => ({ hash: "f".repeat(64), count: 0 }),
  });
  const file = projectCatalogPath(home);
  const saved = JSON.parse(readFileSync(file, "utf8")) as {
    createOperations: Array<{ original: { name: string } }>;
  };
  saved.createOperations[0]!.original.name = "Tampered";
  const corrupted = JSON.stringify(saved);
  writeOwnerOnly(file, corrupted);
  expect(() => store.read()).toThrow();
  await expect(
    store.commitCreate({
      requestId: reserved.operation.requestId,
      requestHash: reserved.operation.requestHash,
      reviewedScopeHash: reserved.operation.scopeHash,
      preflightScope: { hash: reserved.operation.scopeHash, count: 0 },
      validateScope: async () => ({
        hash: reserved.operation.scopeHash,
        count: 0,
      }),
    }),
  ).rejects.toThrow();
  expect(readFileSync(file, "utf8")).toBe(corrupted);
});
