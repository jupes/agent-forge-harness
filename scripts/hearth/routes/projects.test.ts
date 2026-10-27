import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import type { ProjectCatalog } from "../../../types/projects";
import { createProjectStore } from "../../projects/store";
import { withQueueLock } from "../../scheduler/queue-lock";
import { startTestHearth, type TestHearth } from "../testing";
import { writeOwnerOnly } from "../token";

const opened: TestHearth[] = [];
afterEach(async () => {
  for (const h of opened.splice(0)) await h.close();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("projects load through the hearth and audited preferences survive a fresh read", async () => {
  const h = await startTestHearth();
  opened.push(h);
  const store = createProjectStore(h.home);
  const catalog = await store.create(
    {
      slug: "alpha",
      name: "Alpha",
      description: "",
      icon: "A",
      workspaces: [
        {
          root: h.workspace,
          repositories: [h.workspace],
          epicIds: ["alpha-epic"],
        },
      ],
    },
    0,
  );
  const id = catalog.projects[0]?.id;
  const get = await fetch(`${h.api}/projects`, { headers: h.headers() });
  expect(get.status).toBe(200);
  expect(await get.json()).toEqual({ ok: true, data: catalog, error: null });
  const update = await fetch(`${h.api}/projects/${id}/preferences`, {
    method: "POST",
    headers: h.headers(h.hearth.token),
    body: JSON.stringify({ revision: 1, pinned: true }),
  });
  expect(update.status).toBe(200);
  expect(h.events(["operator.action"]).at(-1)?.payload).toMatchObject({
    action: "project.preferences",
    target: id,
  });
  expect(createProjectStore(h.home).read().projects[0]?.pinned).toBe(true);
  const stale = await fetch(`${h.api}/projects/${id}/preferences`, {
    method: "POST",
    headers: h.headers(h.hearth.token),
    body: JSON.stringify({ revision: 1, archived: true }),
  });
  expect(stale.status).toBe(409);
  expect(store.read().projects[0]?.archived).toBe(false);
});

test("a damaged project catalog is a failed read, never empty or overwritten", async () => {
  const h = await startTestHearth();
  opened.push(h);
  writeOwnerOnly(join(h.home, "projects", "catalog.json"), "{");
  const response = await fetch(`${h.api}/projects`, { headers: h.headers() });
  expect(response.status).toBe(503);
  const body: { ok: boolean; data: ProjectCatalog | null } =
    await response.json();
  expect(body.ok).toBe(false);
  expect(body.data).toBeNull();
});

test("a protected project reservation preserves its exact original before project creation", async () => {
  const h = await startTestHearth();
  opened.push(h);
  h.bd.issues.set("alpha-epic", {
    id: "alpha-epic",
    title: "Onboarding epic",
    issue_type: "epic",
    priority: 2,
    status: "open",
    labels: ["project:onboarding-alpha"],
    created_at: "2026-10-26T00:00:00.000Z",
    updated_at: "2026-10-26T00:00:00.000Z",
  });
  h.bd.answer = (args) =>
    args[0] === "export"
      ? {
          status: 0,
          stdout: [...h.bd.issues.values()]
            .map((issue) => JSON.stringify(issue))
            .join("\n"),
          stderr: "",
        }
      : undefined;
  const request = {
    requestId: "63e76212-2d32-4fe2-ab4f-f37a4c827e31",
    expectedCatalogRevision: 0,
    original: {
      slug: "onboarding-alpha",
      name: "Onboarding Alpha",
      description: "",
      icon: "A",
      workspaces: [
        {
          root: h.workspace,
          repositories: [h.workspace],
          epicIds: ["alpha-epic"],
        },
      ],
    },
  };
  const headers = h.headers(h.hearth.token);
  const reserve = await fetch(`${h.api}/projects/create-reservations`, {
    method: "POST",
    headers,
    body: JSON.stringify(request),
  });
  expect(reserve.status).toBe(201);
  const reserved: unknown = await reserve.json();
  expect(reserved).toMatchObject({
    ok: true,
    data: {
      requestId: request.requestId,
      state: "reserved",
      original: request.original,
    },
    error: null,
  });
  expect(createProjectStore(h.home).read().projects).toEqual([]);
  expect(h.events(["operator.action"]).at(-1)?.payload).toMatchObject({
    action: "project.create.reserve",
    family: "project-create",
    requestId: request.requestId,
  });

  const original = await fetch(
    `${h.api}/projects/create-reservations/${request.requestId}`,
    { headers },
  );
  expect(original.status).toBe(200);
  expect(await original.json()).toMatchObject({
    ok: true,
    data: {
      requestId: request.requestId,
      state: "reserved",
      original: request.original,
    },
    error: null,
  });
  expect(h.events(["operator.action"])).toHaveLength(1);
  const listed = await fetch(`${h.api}/projects/create-reservations`, {
    headers,
  });
  expect(listed.status).toBe(200);
  expect(await listed.json()).toMatchObject({
    ok: true,
    data: {
      complete: true,
      operations: [
        {
          requestId: request.requestId,
          state: "reserved",
          scopeCount: 1,
        },
      ],
    },
  });
  const publicCatalog = await fetch(`${h.api}/projects`, { headers });
  expect(await publicCatalog.json()).toEqual({
    ok: true,
    data: { version: 1, revision: 0, projects: [] },
    error: null,
  });
  const summary = await fetch(`${h.api}/projects/summary`, { headers });
  const summaryText = await summary.text();
  expect(summary.status).toBe(200);
  expect(summaryText).not.toContain("createOperations");
  expect(summaryText).not.toContain(request.requestId);
  expect(summaryText).not.toContain(request.original.name);
});

test("a project reservation refuses two allowed spellings of the same checkout before writing", async () => {
  const h = await startTestHearth();
  opened.push(h);
  h.bd.issues.set("alpha-epic", {
    id: "alpha-epic",
    title: "Onboarding epic",
    issue_type: "epic",
    priority: 2,
    status: "open",
    labels: ["project:canonical-alias"],
    created_at: "2026-10-26T00:00:00.000Z",
    updated_at: "2026-10-26T00:00:00.000Z",
  });
  h.bd.answer = (args) =>
    args[0] === "export"
      ? {
          status: 0,
          stdout: [...h.bd.issues.values()]
            .map((issue) => JSON.stringify(issue))
            .join("\n"),
          stderr: "",
        }
      : undefined;

  const store = createProjectStore(h.home);
  const before = store.read();
  const separator = h.workspace.includes("\\") ? "\\" : "/";
  const request = {
    requestId: "6a1310d8-3d4b-4e38-bbdb-391fd2bce280",
    expectedCatalogRevision: before.revision,
    original: {
      slug: "canonical-alias",
      name: "Canonical Alias",
      description: "",
      icon: "A",
      workspaces: [
        {
          root: h.workspace,
          repositories: [h.workspace, `${h.workspace}${separator}`],
          epicIds: ["alpha-epic"],
        },
      ],
    },
  };
  const response = await fetch(`${h.api}/projects/create-reservations`, {
    method: "POST",
    headers: h.headers(h.hearth.token),
    body: JSON.stringify(request),
  });

  expect(response.status).toBe(400);
  expect(store.read()).toEqual(before);
  expect(store.listCreates()).toEqual([]);
  const actions = h.events(["operator.action"]);
  expect(actions).toHaveLength(1);
  expect(actions[0]?.payload).toMatchObject({
    action: "project.create.reserve",
    family: "project-create",
    requestId: request.requestId,
  });
});

test("a reserved project is committed once or explicitly retired without dropping its UUID", async () => {
  const h = await startTestHearth();
  opened.push(h);
  h.bd.issues.set("alpha-epic", {
    id: "alpha-epic",
    title: "Onboarding epic",
    issue_type: "epic",
    priority: 2,
    status: "open",
    labels: ["project:onboarding-alpha"],
    created_at: "2026-10-26T00:00:00.000Z",
    updated_at: "2026-10-26T00:00:00.000Z",
  });
  h.bd.answer = (args) =>
    args[0] === "export"
      ? {
          status: 0,
          stdout: [...h.bd.issues.values()]
            .map((issue) => JSON.stringify(issue))
            .join("\n"),
          stderr: "",
        }
      : undefined;
  const requestId = "21ece531-50de-4af8-aa29-e3407a1b6ff3";
  const original = {
    slug: "onboarding-alpha",
    name: "Onboarding Alpha",
    description: "",
    icon: "A",
    workspaces: [
      {
        root: h.workspace,
        repositories: [h.workspace],
        epicIds: ["alpha-epic"],
      },
    ],
  };
  const headers = h.headers(h.hearth.token);
  const reserve = await fetch(`${h.api}/projects/create-reservations`, {
    method: "POST",
    headers,
    body: JSON.stringify({ requestId, expectedCatalogRevision: 0, original }),
  });
  expect(reserve.status).toBe(201);
  const reserved = await reserve.json();
  expect(reserved).toMatchObject({ ok: true, error: null });
  const requestHash = reserved.data.requestHash as string;
  const scopeHash = reserved.data.scopeHash as string;
  const commitPath = `${h.api}/projects/create-reservations/${requestId}/commit`;
  const commitBody = JSON.stringify({
    requestHash,
    reviewedScopeHash: scopeHash,
  });
  const committed = await fetch(commitPath, {
    method: "POST",
    headers,
    body: commitBody,
  });
  expect(committed.status).toBe(200);
  expect(await committed.json()).toMatchObject({
    ok: true,
    data: { operation: { requestId, state: "created", original } },
  });
  const replay = await fetch(commitPath, {
    method: "POST",
    headers,
    body: commitBody,
  });
  expect(replay.status).toBe(200);
  expect(createProjectStore(h.home).read().projects).toHaveLength(1);

  const otherId = "c2789b83-1b83-4846-9948-7e597fda1c45";
  const retireReserve = await fetch(`${h.api}/projects/create-reservations`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      requestId: otherId,
      expectedCatalogRevision: 1,
      original: {
        ...original,
        slug: "onboarding-beta",
        name: "Onboarding Beta",
      },
    }),
  });
  expect(retireReserve.status).toBe(201);
  const retireData = await retireReserve.json();
  const retired = await fetch(
    `${h.api}/projects/create-reservations/${otherId}/retire`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({ requestHash: retireData.data.requestHash }),
    },
  );
  expect(retired.status).toBe(200);
  expect(await retired.json()).toMatchObject({
    ok: true,
    data: { requestId: otherId, state: "retired-before-create" },
  });
  const staleRetry = await fetch(`${h.api}/projects/create-reservations`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      requestId: otherId,
      expectedCatalogRevision: 1,
      original: {
        ...original,
        slug: "onboarding-beta",
        name: "Onboarding Beta",
      },
    }),
  });
  expect(staleRetry.status).toBe(200);
  expect(await staleRetry.json()).toMatchObject({
    data: { requestId: otherId, state: "retired-before-create" },
  });
  expect(createProjectStore(h.home).read().projects).toHaveLength(1);
});

test("a reservation rechecks live project scope after waiting for the catalog writer", async () => {
  const h = await startTestHearth();
  opened.push(h);
  const initialIssue = {
    id: "alpha-epic",
    title: "Initial selected epic",
    issue_type: "epic",
    priority: 2,
    status: "open",
    labels: ["project:scope-race"],
    created_at: "2026-10-26T00:00:00.000Z",
    updated_at: "2026-10-26T00:00:00.000Z",
  };
  h.bd.issues.set(initialIssue.id, initialIssue);
  const initialRead = deferred<void>();
  h.bd.answer = (args) => {
    if (args[0] !== "export") return undefined;
    initialRead.resolve();
    return {
      status: 0,
      stdout: JSON.stringify(initialIssue),
      stderr: "",
    };
  };

  const locked = deferred<void>();
  const unlock = deferred<void>();
  const writer = withQueueLock(
    join(h.home, "projects", "write.lock.db"),
    async () => {
      locked.resolve();
      await unlock.promise;
    },
    { waitMs: 10_000 },
  );
  await locked.promise;
  const requestId = "a27d0100-ec69-4ca4-99a8-8f5ae66e4112";
  const responsePromise = fetch(`${h.api}/projects/create-reservations`, {
    method: "POST",
    headers: h.headers(h.hearth.token),
    body: JSON.stringify({
      requestId,
      expectedCatalogRevision: 0,
      original: {
        slug: "scope-race",
        name: "Scope Race",
        description: "",
        icon: "R",
        workspaces: [
          {
            root: h.workspace,
            repositories: [h.workspace],
            epicIds: ["alpha-epic"],
          },
        ],
      },
    }),
  });

  try {
    await initialRead.promise;
    h.bd.issues.set(initialIssue.id, {
      ...initialIssue,
      labels: ["project:renamed"],
      updated_at: "2026-10-27T00:00:00.000Z",
    });
    h.bd.answer = (args) =>
      args[0] === "export"
        ? {
            status: 0,
            stdout: [...h.bd.issues.values()]
              .map((issue) => JSON.stringify(issue))
              .join("\n"),
            stderr: "",
          }
        : undefined;
  } finally {
    unlock.resolve();
  }
  await writer;
  const response = await responsePromise;
  expect(response.status).toBe(409);
  expect(createProjectStore(h.home).read().projects).toEqual([]);
  expect(createProjectStore(h.home).listCreates()).toEqual([]);
  expect(h.events(["operator.action"]).at(-1)?.payload).toMatchObject({
    action: "project.create.reserve",
    requestId,
  });
});

test("commit rechecks its reviewed epic source after waiting for the catalog writer", async () => {
  const h = await startTestHearth();
  opened.push(h);
  const initialIssue = {
    id: "alpha-epic",
    title: "Initial selected epic",
    issue_type: "epic",
    priority: 2,
    status: "open",
    labels: ["project:commit-race"],
    created_at: "2026-10-26T00:00:00.000Z",
    updated_at: "2026-10-26T00:00:00.000Z",
  };
  h.bd.issues.set(initialIssue.id, initialIssue);
  h.bd.answer = (args) =>
    args[0] === "export"
      ? {
          status: 0,
          stdout: [...h.bd.issues.values()]
            .map((issue) => JSON.stringify(issue))
            .join("\n"),
          stderr: "",
        }
      : undefined;
  const requestId = "0e274d59-b415-4ad3-b1ac-045abaa0d325";
  const original = {
    slug: "commit-race",
    name: "Commit Race",
    description: "",
    icon: "R",
    workspaces: [
      {
        root: h.workspace,
        repositories: [h.workspace],
        epicIds: ["alpha-epic"],
      },
    ],
  };
  const headers = h.headers(h.hearth.token);
  const reserve = await fetch(`${h.api}/projects/create-reservations`, {
    method: "POST",
    headers,
    body: JSON.stringify({ requestId, expectedCatalogRevision: 0, original }),
  });
  expect(reserve.status).toBe(201);
  const reserved = await reserve.json();
  expect(reserved).toMatchObject({ ok: true, error: null });
  const requestHash = reserved.data.requestHash as string;
  const reviewedScopeHash = reserved.data.scopeHash as string;

  const initialRead = deferred<void>();
  h.bd.answer = (args) => {
    if (args[0] !== "export") return undefined;
    initialRead.resolve();
    return {
      status: 0,
      stdout: JSON.stringify(initialIssue),
      stderr: "",
    };
  };
  const locked = deferred<void>();
  const unlock = deferred<void>();
  const writer = withQueueLock(
    join(h.home, "projects", "write.lock.db"),
    async () => {
      locked.resolve();
      await unlock.promise;
    },
    { waitMs: 10_000 },
  );
  await locked.promise;
  const responsePromise = fetch(
    `${h.api}/projects/create-reservations/${requestId}/commit`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({ requestHash, reviewedScopeHash }),
    },
  );
  try {
    await initialRead.promise;
    h.bd.issues.set(initialIssue.id, {
      ...initialIssue,
      labels: ["project:changed"],
      updated_at: "2026-10-27T00:00:00.000Z",
    });
    h.bd.answer = (args) =>
      args[0] === "export"
        ? {
            status: 0,
            stdout: [...h.bd.issues.values()]
              .map((issue) => JSON.stringify(issue))
              .join("\n"),
            stderr: "",
          }
        : undefined;
  } finally {
    unlock.resolve();
  }
  await writer;
  const response = await responsePromise;
  expect(response.status).toBe(409);
  const current = createProjectStore(h.home);
  expect(current.read().projects).toEqual([]);
  expect(current.readCreate(requestId)).toMatchObject({
    requestHash,
    scopeHash: reviewedScopeHash,
    state: "reserved",
  });
});

test("a lost project commit reply is recovered by its exact UUID without creating a second project", async () => {
  const persisted = deferred<void>();
  const releaseResponse = deferred<void>();
  const h = await startTestHearth({
    api: {
      decorate: (routes) =>
        routes.map((route) => {
          if (
            route.kind !== "action" ||
            route.action !== "project.create.commit"
          )
            return route;
          return {
            ...route,
            effect: async (input, context) => {
              const result = await route.effect(input, context);
              persisted.resolve();
              await releaseResponse.promise;
              return result;
            },
          };
        }),
    },
  });
  opened.push(h);
  h.bd.issues.set("alpha-epic", {
    id: "alpha-epic",
    title: "Onboarding epic",
    issue_type: "epic",
    priority: 2,
    status: "open",
    labels: ["project:lost-reply"],
    created_at: "2026-10-26T00:00:00.000Z",
    updated_at: "2026-10-26T00:00:00.000Z",
  });
  h.bd.answer = (args) =>
    args[0] === "export"
      ? {
          status: 0,
          stdout: [...h.bd.issues.values()]
            .map((issue) => JSON.stringify(issue))
            .join("\n"),
          stderr: "",
        }
      : undefined;
  const requestId = "d49c9700-88a0-4987-a692-449b4639a7b9";
  const original = {
    slug: "lost-reply",
    name: "Lost Reply",
    description: "",
    icon: "L",
    workspaces: [
      {
        root: h.workspace,
        repositories: [h.workspace],
        epicIds: ["alpha-epic"],
      },
    ],
  };
  const headers = h.headers(h.hearth.token);
  const reservation = await fetch(`${h.api}/projects/create-reservations`, {
    method: "POST",
    headers,
    body: JSON.stringify({ requestId, expectedCatalogRevision: 0, original }),
  });
  expect(reservation.status).toBe(201);
  const reserved = await reservation.json();
  expect(reserved).toMatchObject({ ok: true, error: null });
  const requestHash = reserved.data.requestHash as string;
  const reviewedScopeHash = reserved.data.scopeHash as string;
  const controller = new AbortController();
  const request = fetch(
    `${h.api}/projects/create-reservations/${requestId}/commit`,
    {
      method: "POST",
      headers,
      signal: controller.signal,
      body: JSON.stringify({ requestHash, reviewedScopeHash }),
    },
  );
  try {
    await persisted.promise;
    controller.abort();
  } finally {
    releaseResponse.resolve();
  }
  await request.catch(() => undefined);

  const recovered = await fetch(
    `${h.api}/projects/create-reservations/${requestId}`,
    { headers },
  );
  expect(recovered.status).toBe(200);
  expect(await recovered.json()).toMatchObject({
    ok: true,
    data: {
      requestId,
      requestHash,
      state: "created",
      original,
    },
  });
  const replay = await fetch(
    `${h.api}/projects/create-reservations/${requestId}/commit`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({ requestHash, reviewedScopeHash }),
    },
  );
  expect(replay.status).toBe(200);
  expect(createProjectStore(h.home).read().projects).toHaveLength(1);
  expect(createProjectStore(h.home).listCreates()).toHaveLength(1);
});

test("project create reservations preserve legacy catalogs, collide by exact UUID, and serialize slug races", async () => {
  const h = await startTestHearth();
  opened.push(h);
  const store = createProjectStore(h.home);
  writeOwnerOnly(
    join(h.home, "projects", "catalog.json"),
    JSON.stringify({ version: 1, revision: 4, projects: [] }),
  );
  expect(store.read()).toEqual({ version: 1, revision: 4, projects: [] });
  const original = {
    slug: "concurrent-project",
    name: "Concurrent Project",
    description: "",
    icon: "C",
    workspaces: [
      {
        root: h.workspace,
        repositories: [h.workspace],
        epicIds: ["alpha-epic"],
      },
    ],
  };
  const firstId = "5a3b32b3-3e0d-4bba-a143-f7d72d6c12c4";
  const first = await store.reserveCreate({
    requestId: firstId,
    original,
    expectedCatalogRevision: 4,
    preflightScope: { hash: "d".repeat(64), count: 0 },
    validateScope: async () => ({ hash: "d".repeat(64), count: 0 }),
  });
  expect(first.catalog.revision).toBe(4);
  expect(store.readCreate(firstId)?.requestHash).toBe(
    first.operation.requestHash,
  );
  expect(
    store.reserveCreate({
      requestId: firstId,
      original: { ...original, name: "Changed original" },
      expectedCatalogRevision: 4,
      preflightScope: { hash: "d".repeat(64), count: 0 },
      validateScope: async () => ({ hash: "d".repeat(64), count: 0 }),
    }),
  ).rejects.toMatchObject({ status: 409 });

  const contenders = await Promise.allSettled(
    [
      "a39713d5-39c7-4ef7-b1ea-673122ae6b91",
      "54cf6ebf-a764-43df-8ad7-920048a98b19",
    ].map((requestId) =>
      store.reserveCreate({
        requestId,
        original: { ...original, slug: "concurrent-second" },
        expectedCatalogRevision: 4,
        preflightScope: { hash: "e".repeat(64), count: 0 },
        validateScope: async () => ({ hash: "e".repeat(64), count: 0 }),
      }),
    ),
  );
  expect(
    contenders.filter((result) => result.status === "fulfilled"),
  ).toHaveLength(1);
  expect(
    contenders.filter((result) => result.status === "rejected"),
  ).toHaveLength(1);
  const catalog = store.read();
  expect(catalog.revision).toBe(4);
  expect(catalog.createOperations).toHaveLength(2);
  expect(catalog.projects).toEqual([]);
});
