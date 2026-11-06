import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeOwnerOnly } from "../hearth/token";
import { resolveCheckout } from "../ledger/workspace";
import { projectCreateOriginalSchema } from "./create-protocol";
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

test("general metadata updates advance one revision and preserve project and create-ledger fields", async () => {
  const { home, store, input } = fixture();
  const created = await store.create(
    { ...input, color: "blue", keeperSmith: "claude-master" },
    0,
  );
  const id = created.projects[0]?.id;
  if (!id) throw new Error("project missing");
  const withSecondProject = await store.create(
    { ...input, slug: "beta", name: "Beta" },
    created.revision,
  );
  const preferred = await store.preferences(id, withSecondProject.revision, {
    pinned: true,
    archived: true,
  });
  writeOwnerOnly(
    projectCatalogPath(home),
    JSON.stringify({ ...preferred, createOperations: [] }),
  );
  const before = store.read();
  const original = before.projects[0];
  if (!original) throw new Error("project missing");
  const updated = await store.updateGeneral(id, before.revision, {
    name: "Renamed",
    description: "Updated description",
    icon: "G",
  });
  expect(updated.revision).toBe(before.revision + 1);
  const expectedProject = {
    ...original,
    name: "Renamed",
    description: "Updated description",
    icon: "G",
    updatedAt: expect.any(String),
  };
  delete expectedProject.color;
  expect(updated.projects[0]).toEqual(expectedProject);
  expect(updated.projects[0]).not.toHaveProperty("color");
  expect(updated.projects[1]).toEqual(before.projects[1]);
  expect(Object.hasOwn(updated, "createOperations")).toBe(true);
  expect(updated.createOperations).toEqual([]);
  expect(store.read()).toEqual(updated);
  await expect(
    store.updateGeneral(id, before.revision, {
      name: "Stale",
      description: "",
      icon: "S",
    }),
  ).rejects.toMatchObject({ status: 409 });

  const pendingId = "ec61d4ee-8951-4f63-8c4b-ecfca0067c17";
  const pendingOriginal = { ...input, slug: "reserved" };
  const pendingReservation = await store.reserveCreate({
    requestId: pendingId,
    original: pendingOriginal,
    expectedCatalogRevision: updated.revision,
    preflightScope: { hash: "a".repeat(64), count: 0 },
    validateScope: async () => ({ hash: "a".repeat(64), count: 0 }),
  });
  expect(pendingReservation.operation.state).toBe("reserved");
  const exactPending = createProjectStore(home).readCreate(pendingId);
  expect(exactPending).toEqual(pendingReservation.operation);
  const withPending = await store.updateGeneral(id, updated.revision, {
    name: "Renamed with pending create",
    description: "",
    icon: "P",
  });
  expect(withPending.revision).toBe(updated.revision + 1);
  expect(store.readCreate(pendingId)).toEqual(exactPending);
  expect(store.readCreate(pendingId)).toMatchObject({
    state: "reserved",
    original: pendingOriginal,
  });
  expect(createProjectStore(home).readCreate(pendingId)).toEqual(exactPending);

  const legacy = fixture();
  const legacyCreated = await legacy.store.create(legacy.input, 0);
  const legacyId = legacyCreated.projects[0]?.id;
  if (!legacyId) throw new Error("legacy project missing");
  const legacyUpdated = await legacy.store.updateGeneral(
    legacyId,
    legacyCreated.revision,
    { name: "Legacy renamed", description: "", icon: "L" },
  );
  expect(Object.hasOwn(legacyUpdated, "createOperations")).toBe(false);
});

test("a created project keeps its private original through General edits and exact replay", async () => {
  const { home, input } = fixture();
  let tick = 0;
  const now = () => new Date(Date.UTC(2026, 10, 1, 0, 0, tick++));
  const store = createProjectStore(home, now);
  const requestId = "63a53f91-3ac3-4cf6-8be0-c929cdf864a7";
  const scope = { hash: "a".repeat(64), count: 1 };
  const checkoutPath = join(home, "checkout");
  mkdirSync(join(checkoutPath, ".git"), { recursive: true });
  const canonicalCheckout = resolveCheckout(checkoutPath).workspace;
  const original = {
    ...input,
    keeperSmith: "claude-master",
    color: "blue" as const,
    workspaces: [
      {
        root: canonicalCheckout,
        repositories: [canonicalCheckout],
        epicIds: input.workspaces[0]!.epicIds,
      },
    ],
  };
  expect(original.workspaces[0]?.root).toBe(canonicalCheckout);
  expect(original.workspaces[0]?.repositories).toEqual([canonicalCheckout]);
  const validateScope = async () => scope;
  const validateKeeperSmith = (name: string) =>
    expect(name).toBe("claude-master");

  const reserved = await store.reserveCreate({
    requestId,
    original,
    expectedCatalogRevision: 0,
    preflightScope: scope,
    validateScope,
    validateKeeperSmith,
  });
  expect(reserved.created).toBe(true);
  expect(reserved.catalog).toMatchObject({ revision: 0, projects: [] });
  expect(reserved.operation).toMatchObject({
    requestId,
    original,
    state: "reserved",
    projectId: null,
    createdRevision: null,
  });
  const reservedReader = createProjectStore(home, now);
  expect(reservedReader.read()).toEqual(reserved.catalog);
  expect(reservedReader.readCreate(requestId)).toEqual(reserved.operation);

  const created = await store.commitCreate({
    requestId,
    requestHash: reserved.operation.requestHash,
    reviewedScopeHash: reserved.operation.scopeHash,
    preflightScope: scope,
    validateScope,
    validateKeeperSmith,
  });
  expect(created.catalog.revision).toBe(1);
  expect(created.catalog.projects).toHaveLength(1);
  expect(created.operation).toMatchObject({
    requestId,
    requestHash: reserved.operation.requestHash,
    original,
    state: "created",
    projectId: expect.any(String),
    createdRevision: 1,
  });
  const createdProject = created.catalog.projects[0];
  if (!createdProject) throw new Error("created project missing");
  expect(createdProject).toMatchObject({
    slug: original.slug,
    color: "blue",
    keeperSmith: "claude-master",
    workspaces: original.workspaces,
  });
  const createdReader = createProjectStore(home, now);
  expect(createdReader.read()).toEqual(created.catalog);
  expect(createdReader.readCreate(requestId)).toEqual(created.operation);
  const serializedOperations = () => {
    const saved = JSON.parse(
      readFileSync(projectCatalogPath(home), "utf8"),
    ) as {
      createOperations?: unknown[];
    };
    return JSON.stringify(saved.createOperations);
  };
  const savedOperations = serializedOperations();

  const edited = await store.updateGeneral(
    createdProject.id,
    createdReader.read().revision,
    {
      name: "Alpha revised",
      description: "Updated description",
      icon: "B",
      color: "green",
    },
  );
  expect(edited.revision).toBe(created.catalog.revision + 1);
  expect(edited.projects).toHaveLength(1);
  const editedProject = edited.projects[0];
  if (!editedProject) throw new Error("edited project missing");
  expect(editedProject).toMatchObject({
    id: createdProject.id,
    slug: createdProject.slug,
    name: "Alpha revised",
    description: "Updated description",
    icon: "B",
    color: "green",
    workspaces: createdProject.workspaces,
    keeperSmith: createdProject.keeperSmith,
    pinned: createdProject.pinned,
    archived: createdProject.archived,
    createdAt: createdProject.createdAt,
    updatedAt: expect.any(String),
  });
  expect(editedProject.updatedAt).not.toBe(createdProject.updatedAt);
  expect(serializedOperations()).toBe(savedOperations);
  const editedReader = createProjectStore(home, now);
  expect(editedReader.read()).toEqual(edited);
  expect(editedReader.readCreate(requestId)).toEqual(created.operation);

  const replay = await store.commitCreate({
    requestId,
    requestHash: reserved.operation.requestHash,
    reviewedScopeHash: reserved.operation.scopeHash,
    preflightScope: scope,
    validateScope: async () => {
      throw new Error("created replay must not validate scope again");
    },
    validateKeeperSmith: () => {
      throw new Error("created replay must not validate Keeper again");
    },
  });
  expect(replay.operation).toEqual(created.operation);
  expect(replay.catalog).toEqual(editedReader.read());
  expect(replay.catalog.revision).toBe(edited.revision);
  expect(replay.catalog.projects).toHaveLength(1);
  expect(replay.catalog.projects[0]).toEqual(editedProject);
  expect(serializedOperations()).toBe(savedOperations);

  const colorCleared = await store.updateGeneral(
    createdProject.id,
    replay.catalog.revision,
    {
      name: editedProject.name,
      description: editedProject.description,
      icon: editedProject.icon,
    },
  );
  expect(colorCleared.revision).toBe(replay.catalog.revision + 1);
  const clearedProject = colorCleared.projects[0];
  if (!clearedProject) throw new Error("cleared project missing");
  expect(Object.hasOwn(clearedProject, "color")).toBe(false);
  expect(clearedProject).toMatchObject({
    id: createdProject.id,
    slug: createdProject.slug,
    workspaces: createdProject.workspaces,
    keeperSmith: createdProject.keeperSmith,
    pinned: createdProject.pinned,
    archived: createdProject.archived,
    createdAt: createdProject.createdAt,
  });
  expect(serializedOperations()).toBe(savedOperations);
  const clearedReader = createProjectStore(home, now);
  expect(clearedReader.read()).toEqual(colorCleared);
  expect(clearedReader.readCreate(requestId)).toEqual(created.operation);
  expect(serializedOperations()).toBe(savedOperations);

  const clearedReplay = await store.commitCreate({
    requestId,
    requestHash: reserved.operation.requestHash,
    reviewedScopeHash: reserved.operation.scopeHash,
    preflightScope: scope,
    validateScope: async () => {
      throw new Error(
        "created replay after color clearing must not validate scope again",
      );
    },
    validateKeeperSmith: () => {
      throw new Error(
        "created replay after color clearing must not validate Keeper again",
      );
    },
  });
  expect(clearedReplay.operation).toEqual(created.operation);
  expect(clearedReplay.catalog).toEqual(colorCleared);
  expect(clearedReplay.catalog.revision).toBe(colorCleared.revision);
  expect(clearedReplay.catalog.projects).toEqual([clearedProject]);
  expect(serializedOperations()).toBe(savedOperations);
  expect(clearedReader.readCreate(requestId)).toEqual(created.operation);
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
  const checkoutPath = join(home, "checkout");
  mkdirSync(join(checkoutPath, ".git"), { recursive: true });
  const checkout = resolveCheckout(checkoutPath).workspace;
  const checkoutAlias = join(home, "checkout-alias");
  symlinkSync(
    checkout,
    checkoutAlias,
    process.platform === "win32" ? "junction" : "dir",
  );
  const canonicalCheckout = resolveCheckout(checkoutAlias).workspace;
  expect(canonicalCheckout).not.toBe(checkoutAlias);
  const original = {
    ...input,
    workspaces: [
      {
        root: canonicalCheckout,
        repositories: [canonicalCheckout],
        epicIds: ["demo-epic"],
      },
    ],
  };
  const requestId = "bba4e479-101f-48c4-bbb8-04f242e3d325";
  const legacyHash = hashProjectCreateRequest({
    requestId,
    expectedCatalogRevision: 0,
    original,
  });
  const explicitOriginal = Object.assign({}, original, {
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
  expect(committedProject?.slug).toBe(original.slug);
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
      original: Object.assign({}, original, {
        keeperSmith: "codex-journeyman",
      }),
      expectedCatalogRevision: 0,
      preflightScope: { hash: "a".repeat(64), count: 0 },
      validateScope: async () => ({ hash: "a".repeat(64), count: 0 }),
    }),
  ).rejects.toMatchObject({ status: 409 });

  const originalOperation = JSON.stringify(store.readCreate(requestId));
  if (!committedProject) throw Error("missing committed project");
  const changed = await store.updateKeeper(
    committedProject.id,
    committed.catalog.revision,
    { keeperSmith: "codex-journeyman" },
    () => {},
  );
  expect(createProjectStore(home).read().projects[0]?.keeperSmith).toBe(
    "codex-journeyman",
  );
  expect(JSON.stringify(store.readCreate(requestId))).toBe(originalOperation);
  const replay = await store.commitCreate({
    requestId,
    requestHash: explicitHash,
    reviewedScopeHash: reservation.operation.scopeHash,
    preflightScope: { hash: reservation.operation.scopeHash, count: 0 },
    validateScope: async () => {
      throw Error("created replay does not revalidate");
    },
  });
  expect(replay.catalog).toEqual(changed);
  expect(JSON.stringify(replay.operation)).toBe(originalOperation);
});

test("a legacy original commits on the direct store path without a Keeper field", async () => {
  const { home, store, input } = fixture();
  const checkout = join(home, "checkout");
  mkdirSync(join(checkout, ".git"), { recursive: true });
  const checkoutAlias = join(home, "checkout-alias");
  symlinkSync(
    checkout,
    checkoutAlias,
    process.platform === "win32" ? "junction" : "dir",
  );
  const canonicalCheckout = resolveCheckout(checkoutAlias).workspace;
  expect(canonicalCheckout).not.toBe(checkoutAlias);
  const original = {
    ...input,
    workspaces: [
      {
        root: canonicalCheckout,
        repositories: [canonicalCheckout],
        epicIds: ["demo-epic"],
      },
    ],
  };
  const requestId = "5e091eab-8a4f-45dc-8fbb-19e9425d5c4e";
  const reservation = await store.reserveCreate({
    requestId,
    original,
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
  expect(committed.catalog.projects[0]?.slug).toBe(original.slug);
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

test("legacy project originals keep their absent color and create hash unchanged", async () => {
  const { home, store, input } = fixture();
  const requestId = "4b3aa122-2cf2-4edb-ae94-fcc29ff19a30";
  const original = { ...input };
  const hash = hashProjectCreateRequest({
    requestId,
    expectedCatalogRevision: 0,
    original,
  });
  const reserved = await store.reserveCreate({
    requestId,
    original,
    expectedCatalogRevision: 0,
    preflightScope: { hash: "d".repeat(64), count: 1 },
    validateScope: async () => ({ hash: "d".repeat(64), count: 1 }),
  });
  const bytes = readFileSync(projectCatalogPath(home), "utf8");
  const saved = JSON.parse(bytes) as {
    createOperations: Array<{ original: Record<string, unknown> }>;
  };
  const reopened = createProjectStore(home).readCreate(requestId);
  expect(reserved.operation.requestHash).toBe(hash);
  expect(reopened).toEqual(reserved.operation);
  expect(reopened?.requestHash).toBe(hash);
  expect(Object.hasOwn(reopened?.original ?? {}, "color")).toBe(false);
  expect(saved.createOperations[0]?.original).toEqual(original);
  expect(
    Object.hasOwn(saved.createOperations[0]?.original ?? {}, "color"),
  ).toBe(false);
  expect(bytes).toBe(readFileSync(projectCatalogPath(home), "utf8"));

  const fixedLegacyOriginal = {
    slug: "alpha",
    name: "Alpha",
    description: "A scoped project",
    icon: "A",
    workspaces: [
      {
        root: "C:\\repo",
        repositories: ["C:\\repo"],
        epicIds: ["demo-epic"],
      },
    ],
  };
  expect(
    hashProjectCreateRequest({
      requestId,
      expectedCatalogRevision: 0,
      original: fixedLegacyOriginal,
    }),
  ).toBe("e40ff6ef46f0ebd197ef281770868f6856ffcea886763a64b458536ae371b2b2");
});

test("bounded project color IDs are hash-bound and survive exact create readback", async () => {
  const { home, store, input } = fixture();
  const checkoutPath = join(home, "checkout");
  mkdirSync(join(checkoutPath, ".git"), { recursive: true });
  const checkout = resolveCheckout(checkoutPath).workspace;
  const base = {
    ...input,
    workspaces: [
      { root: checkout, repositories: [checkout], epicIds: ["demo-epic"] },
    ],
  };
  const colors = ["default", "green", "blue"] as const;

  for (const [index, color] of colors.entries()) {
    const requestId = [
      "94111a92-01d0-42fc-a390-408e6f5515e6",
      "a8112b0e-2334-47e2-86da-5c3603c3c428",
      "25e8d00a-8493-4e66-9f62-2fc2ff68715e",
    ][index]!;
    const original = {
      ...base,
      slug: `alpha-${color}`,
      name: `Alpha ${color}`,
      color,
    };
    const parsed = projectCreateOriginalSchema.safeParse(original);
    expect(parsed.success).toBe(true);
    if (!parsed.success) continue;

    const expectedCatalogRevision = store.read().revision;
    const expectedHash = hashProjectCreateRequest({
      requestId,
      expectedCatalogRevision,
      original: parsed.data,
    });
    if (color === "default") {
      expect(
        hashProjectCreateRequest({
          requestId,
          expectedCatalogRevision,
          original: {
            ...base,
            slug: `alpha-${color}`,
            name: `Alpha ${color}`,
          },
        }),
      ).not.toBe(expectedHash);
    }
    const reserved = await store.reserveCreate({
      requestId,
      original: parsed.data,
      expectedCatalogRevision,
      preflightScope: { hash: "e".repeat(64), count: 1 },
      validateScope: async () => ({ hash: "e".repeat(64), count: 1 }),
    });
    expect(reserved.operation.original).toMatchObject({ color });
    expect(reserved.operation.requestHash).toBe(expectedHash);

    const committed = await store.commitCreate({
      requestId,
      requestHash: expectedHash,
      reviewedScopeHash: reserved.operation.scopeHash,
      preflightScope: { hash: reserved.operation.scopeHash, count: 1 },
      validateScope: async () => ({
        hash: reserved.operation.scopeHash,
        count: 1,
      }),
    });
    expect(committed.catalog.projects.at(-1)).toMatchObject({ color });
    expect(createProjectStore(home).readCreate(requestId)).toMatchObject({
      original: { color },
      requestHash: expectedHash,
      state: "created",
    });
    expect(createProjectStore(home).read().projects.at(-1)).toMatchObject({
      color,
    });
    await expect(
      store.reserveCreate({
        requestId,
        original: {
          ...base,
          slug: `alpha-${color}`,
          name: `Alpha ${color}`,
          color: color === "green" ? "blue" : "green",
        },
        expectedCatalogRevision,
        preflightScope: { hash: "e".repeat(64), count: 1 },
        validateScope: async () => ({ hash: "e".repeat(64), count: 1 }),
      }),
    ).rejects.toMatchObject({ status: 409 });
  }

  const file = projectCatalogPath(home);
  const saved = JSON.parse(readFileSync(file, "utf8")) as {
    projects: Array<Record<string, unknown>>;
  };
  saved.projects[0]!.color = "purple";
  const corrupted = JSON.stringify(saved);
  writeOwnerOnly(file, corrupted);
  expect(() => store.read()).toThrow();
  expect(readFileSync(file, "utf8")).toBe(corrupted);
});

test("project color protocol rejects arbitrary CSS and unknown token names", () => {
  const { input } = fixture();
  expect(
    projectCreateOriginalSchema.safeParse({ ...input, color: "#dcf1e6" })
      .success,
  ).toBe(false);
  expect(
    projectCreateOriginalSchema.safeParse({ ...input, color: "purple" })
      .success,
  ).toBe(false);
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

test("Keeper defaults persist with revision conflicts and configured validation", async () => {
  const { home, store, input } = fixture();
  const created = await store.create(input, 0);
  const project = created.projects[0]!;
  const seen: string[] = [];
  const updated = await store.updateKeeper(
    project.id,
    1,
    { keeperSmith: "codex-journeyman" },
    (name) => {
      seen.push(name);
    },
  );
  expect(seen).toEqual(["codex-journeyman"]);
  expect(updated.revision).toBe(2);
  expect(createProjectStore(home).read().projects[0]?.keeperSmith).toBe(
    "codex-journeyman",
  );
  expect(updated.projects[0]).toMatchObject({
    name: project.name,
    workspaces: project.workspaces,
  });
  await expect(
    store.updateKeeper(
      project.id,
      1,
      { keeperSmith: "claude-master" },
      () => {},
    ),
  ).rejects.toMatchObject({ status: 409 });
  await expect(
    store.updateKeeper(project.id, 2, { keeperSmith: "unknown" }, () => {
      throw Error("unconfigured");
    }),
  ).rejects.toThrow("unconfigured");
  expect(store.read()).toEqual(updated);
  await expect(
    store.updateKeeper(project.id, 2, { keeperSmith: "" }, () => {}),
  ).rejects.toMatchObject({ status: 400 });
  const inherited = await store.updateKeeper(project.id, 2, {}, () => {
    throw Error("no explicit selection");
  });
  expect(Object.hasOwn(inherited.projects[0]!, "keeperSmith")).toBe(false);
});
