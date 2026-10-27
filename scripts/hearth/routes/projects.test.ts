import { afterEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ProjectCatalog } from "../../../types/projects";
import { resolveCheckout } from "../../ledger/workspace";
import { workspaceKey } from "../../projects/scope";
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

test("protected project-create options expose complete trusted choices without writes", async () => {
  const h = await startTestHearth();
  opened.push(h);
  h.bd.issues.set("onboarding-epic", {
    id: "onboarding-epic",
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
  const catalogBefore = createProjectStore(h.home).read();
  const privateRequest = {
    requestId: "a45b3815-cf25-4b2e-bab7-90b21e7732fd",
    expectedCatalogRevision: catalogBefore.revision,
    original: {
      slug: "onboarding-alpha",
      name: "Private onboarding draft",
      description: "",
      icon: "A",
      workspaces: [
        {
          root: h.workspace,
          repositories: [h.workspace],
          epicIds: ["onboarding-epic"],
        },
      ],
    },
  };
  const reservation = await fetch(`${h.api}/projects/create-reservations`, {
    method: "POST",
    headers: h.headers(h.hearth.token),
    body: JSON.stringify(privateRequest),
  });
  expect(reservation.status).toBe(201);
  const catalogAfterSeed = createProjectStore(h.home).read();
  const eventsBeforeRead = h.events(["operator.action"]);

  const options = await fetch(`${h.api}/projects/create-options`, {
    headers: h.headers(h.hearth.token),
  });
  expect(options.status).toBe(200);
  const optionsBody = await options.text();
  let parsedOptions: unknown;
  try {
    parsedOptions = JSON.parse(optionsBody);
  } catch {
    throw new Error("The project-create options response was not JSON.");
  }
  expect(parsedOptions).toMatchObject({
    ok: true,
    data: {
      complete: true,
      workspace: { path: h.workspace },
      repositories: [{ path: h.workspace, served: true }],
      epics: [{ id: "onboarding-epic", title: "Onboarding epic" }],
    },
    error: null,
  });
  expect(optionsBody).not.toContain(privateRequest.requestId);
  expect(optionsBody).not.toContain(privateRequest.original.name);
  expect(optionsBody).not.toContain("requestHash");
  const protectedRead = await fetch(`${h.api}/projects/create-options`, {
    headers: h.headers(),
  });
  expect(protectedRead.status).toBe(403);
  expect(h.events(["operator.action"])).toEqual(eventsBeforeRead);
  expect(createProjectStore(h.home).read()).toEqual(catalogAfterSeed);
  expect(h.bd.calls.every((args) => args[0] === "export")).toBe(true);
});

test("project scope preview uses the reservation count/hash and remains read-only", async () => {
  const h = await startTestHearth();
  opened.push(h);
  h.bd.issues.set("onboarding-epic", {
    id: "onboarding-epic",
    title: "Onboarding epic",
    issue_type: "epic",
    priority: 2,
    status: "open",
    labels: ["project:onboarding-alpha"],
    created_at: "2026-10-26T00:00:00.000Z",
    updated_at: "2026-10-26T00:00:00.000Z",
  });
  h.bd.issues.set("onboarding-task", {
    id: "onboarding-task",
    title: "First task",
    issue_type: "task",
    priority: 2,
    status: "open",
    labels: ["project:onboarding-alpha"],
    dependencies: [
      {
        issue_id: "onboarding-task",
        depends_on_id: "onboarding-epic",
        type: "parent-child",
      },
    ],
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
  const before = createProjectStore(h.home).read();
  const query = new URLSearchParams([
    ["slug", "onboarding-alpha"],
    ["epicId", "onboarding-epic"],
  ]);
  const previewResponse = await fetch(
    `${h.api}/projects/create-scope-preview?${query}`,
    { headers: h.headers(h.hearth.token) },
  );
  expect(previewResponse.status).toBe(200);
  const preview = (await previewResponse.json()) as {
    ok: boolean;
    data: { complete: boolean; scopeCount: number; scopeHash: string } | null;
    error: string | null;
  };
  expect(preview).toMatchObject({
    ok: true,
    data: { complete: true, scopeCount: 2 },
    error: null,
  });
  expect(preview.data).not.toBeNull();
  expect(h.events(["operator.action"])).toEqual([]);
  expect(createProjectStore(h.home).read()).toEqual(before);

  const request = {
    requestId: "4a965437-e738-43c5-9025-e28ab4ebedcc",
    expectedCatalogRevision: before.revision,
    original: {
      slug: "onboarding-alpha",
      name: "Onboarding Alpha",
      description: "",
      icon: "A",
      workspaces: [
        {
          root: h.workspace,
          repositories: [h.workspace],
          epicIds: ["onboarding-epic"],
        },
      ],
    },
  };
  const reserveResponse = await fetch(`${h.api}/projects/create-reservations`, {
    method: "POST",
    headers: h.headers(h.hearth.token),
    body: JSON.stringify(request),
  });
  expect(reserveResponse.status).toBe(201);
  const reserve = (await reserveResponse.json()) as {
    ok: boolean;
    data: { scopeCount: number; scopeHash: string } | null;
    error: string | null;
  };
  expect(reserve.data).not.toBeNull();
  expect(preview.data?.scopeCount).toBe(reserve.data?.scopeCount);
  expect(preview.data?.scopeHash).toBe(reserve.data?.scopeHash);
});

test("project-create reads reject malformed queries and fail closed on incomplete tracker exports", async () => {
  const h = await startTestHearth();
  opened.push(h);
  const headers = h.headers(h.hearth.token);
  const invalidQueries = [
    "?epicId=alpha-epic",
    "?slug=Not-Lowercase&epicId=alpha-epic",
    "?slug=alpha&epicId=alpha-epic&epicId=alpha-epic",
    "?slug=alpha&epicId=alpha-epic&unknown=value",
    `?slug=alpha&${Array.from({ length: 65 }, (_, index) => `epicId=id-${index}`).join("&")}`,
  ];
  for (const query of invalidQueries) {
    const response = await fetch(
      `${h.api}/projects/create-scope-preview${query}`,
      { headers },
    );
    expect(response.status).toBe(400);
  }
  const optionsWithQuery = await fetch(
    `${h.api}/projects/create-options?unknown=value`,
    { headers },
  );
  expect(optionsWithQuery.status).toBe(400);
  expect(h.bd.calls).toHaveLength(0);

  h.bd.answer = (args) =>
    args[0] === "export"
      ? { status: 0, stdout: '{"id":', stderr: "" }
      : undefined;
  const unavailable = await fetch(`${h.api}/projects/create-options`, {
    headers,
  });
  expect(unavailable.status).toBe(503);
  expect(await unavailable.json()).toMatchObject({
    ok: false,
    data: null,
  });
  expect(h.events(["operator.action"])).toEqual([]);
});

test("scope preview distinguishes a known empty scope from an unknown epic", async () => {
  const h = await startTestHearth();
  opened.push(h);
  h.bd.answer = (args) =>
    args[0] === "export"
      ? {
          status: 0,
          stdout: JSON.stringify({
            id: "unassigned-epic",
            title: "Unassigned epic",
            issue_type: "epic",
            priority: 2,
            status: "open",
            created_at: "2026-10-26T00:00:00.000Z",
            updated_at: "2026-10-26T00:00:00.000Z",
          }),
          stderr: "",
        }
      : undefined;
  const known = await fetch(
    `${h.api}/projects/create-scope-preview?slug=empty-project&epicId=unassigned-epic`,
    { headers: h.headers(h.hearth.token) },
  );
  expect(known.status).toBe(200);
  expect(await known.json()).toMatchObject({
    ok: true,
    data: { complete: true, scopeCount: 0 },
  });
  const unknown = await fetch(
    `${h.api}/projects/create-scope-preview?slug=empty-project&epicId=not-in-export`,
    { headers: h.headers(h.hearth.token) },
  );
  expect(unknown.status).toBe(409);
  expect(h.events(["operator.action"])).toEqual([]);
});

test("project-create options include registered canonical repos or refuse the incomplete registry", async () => {
  const h = await startTestHearth({
    files: {
      "repos/repos.json": JSON.stringify({
        repos: [
          {
            name: "registered-repo",
            url: "https://example.invalid/repo",
            defaultBranch: "main",
          },
        ],
      }),
    },
  });
  opened.push(h);
  const checkout = join(h.root, "repos", "registered-repo");
  mkdirSync(join(checkout, ".git"), { recursive: true });
  const response = await fetch(`${h.api}/projects/create-options`, {
    headers: h.headers(h.hearth.token),
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    ok: true,
    data: {
      complete: true,
      repositories: [
        { path: h.workspace, served: true },
        {
          path: resolveCheckout(checkout).worktree,
          name: "registered-repo",
          served: false,
        },
      ],
    },
    error: null,
  });

  const missing = await startTestHearth({
    files: {
      "repos/repos.json": JSON.stringify({
        repos: [
          {
            name: "missing-repo",
            url: "https://example.invalid/missing",
            defaultBranch: "main",
          },
        ],
      }),
    },
  });
  opened.push(missing);
  const unavailable = await fetch(`${missing.api}/projects/create-options`, {
    headers: missing.headers(missing.hearth.token),
  });
  expect(unavailable.status).toBe(503);
  expect(await unavailable.json()).toMatchObject({ ok: false, data: null });
});

test("trusted registry override is shared by options, preview, reserve, and commit", async () => {
  const h = await startTestHearth({
    linkedWorktree: true,
    projectRepositoryRegistryRoot: (home) => join(home, "fixture-registry"),
  });
  opened.push(h);
  if (!h.main) throw new Error("the linked-worktree fixture needs a main root");

  const injectedRoot = join(h.home, "fixture-registry");
  const injectedName = "onboarding-fixture";
  const injectedCheckout = join(injectedRoot, "repos", injectedName);
  mkdirSync(join(injectedCheckout, ".git"), { recursive: true });
  writeFileSync(
    join(injectedRoot, "repos", "repos.json"),
    JSON.stringify({
      repos: [
        {
          name: injectedName,
          url: "https://example.invalid/onboarding-fixture",
          defaultBranch: "main",
        },
      ],
    }),
  );

  const leakedName = "must-not-leak-from-real-root";
  const leakedCheckout = join(h.main, "repos", leakedName);
  mkdirSync(join(leakedCheckout, ".git"), { recursive: true });
  writeFileSync(
    join(h.main, "repos", "repos.json"),
    JSON.stringify({
      repos: [
        {
          name: leakedName,
          url: "https://example.invalid/real-root-only",
          defaultBranch: "main",
        },
      ],
    }),
  );

  const epicId = "project-create-registry-epic";
  h.bd.issues.set(epicId, {
    id: epicId,
    title: "Project create registry epic",
    issue_type: "epic",
    priority: 2,
    status: "open",
    labels: ["project:registry-override"],
    created_at: "2026-10-27T00:00:00.000Z",
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

  const headers = h.headers(h.hearth.token);
  const before = createProjectStore(h.home).read();
  const optionsResponse = await fetch(`${h.api}/projects/create-options`, {
    headers,
  });
  expect(optionsResponse.status).toBe(200);
  const optionsEnvelope = await optionsResponse.json();
  expect(optionsEnvelope).toMatchObject({ ok: true, error: null });
  const optionRows = optionsEnvelope.data.repositories as Array<{
    path: string;
    key: string;
    name: string;
    served: boolean;
  }>;
  const injectedPath = resolveCheckout(injectedCheckout).worktree;
  expect(optionRows).toContainEqual({
    path: injectedPath,
    key: workspaceKey(injectedPath),
    name: injectedName,
    served: false,
  });
  expect(optionRows.some((row) => row.name === leakedName)).toBe(false);
  expect(optionRows.filter((row) => row.served)).toHaveLength(1);

  const slug = "registry-override-project";
  const previewResponse = await fetch(
    `${h.api}/projects/create-scope-preview?${new URLSearchParams({
      slug,
      epicId,
    })}`,
    { headers },
  );
  expect(previewResponse.status).toBe(200);
  const previewEnvelope = await previewResponse.json();
  expect(previewEnvelope).toMatchObject({ ok: true, error: null });
  const preview = previewEnvelope.data as {
    scopeHash: string;
    scopeCount: number;
  };

  expect(createProjectStore(h.home).read()).toEqual(before);
  expect(h.events(["operator.action"])).toEqual([]);

  const requestId = "20caf845-92e1-4cc5-a6fb-44d74d11a84c";
  const original = {
    slug,
    name: "Registry Override Project",
    description: "",
    icon: "R",
    workspaces: [
      {
        root: h.workspace,
        repositories: [h.workspace, injectedPath],
        epicIds: [epicId],
      },
    ],
  };
  const reserveResponse = await fetch(`${h.api}/projects/create-reservations`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      requestId,
      expectedCatalogRevision: before.revision,
      original,
    }),
  });
  expect(reserveResponse.status).toBe(201);
  const reserveEnvelope = await reserveResponse.json();
  expect(reserveEnvelope).toMatchObject({ ok: true, error: null });
  expect(reserveEnvelope.data).toMatchObject({
    requestId,
    state: "reserved",
    original,
    scopeHash: preview.scopeHash,
    scopeCount: preview.scopeCount,
  });
  expect(createProjectStore(h.home).read()).toEqual(before);

  const commitResponse = await fetch(
    `${h.api}/projects/create-reservations/${requestId}/commit`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        requestHash: reserveEnvelope.data.requestHash,
        reviewedScopeHash: preview.scopeHash,
      }),
    },
  );
  expect(commitResponse.status).toBe(200);
  expect(await commitResponse.json()).toMatchObject({
    ok: true,
    data: { operation: { requestId, state: "created", original } },
    error: null,
  });
  expect(createProjectStore(h.home).read().projects).toHaveLength(1);
  expect(
    h.events(["operator.action"]).map((event) => event.payload),
  ).toMatchObject([
    { action: "project.create.reserve", requestId },
    { action: "project.create", requestId },
  ]);
});

test("an invalid trusted registry override refuses without falling back to the real root", async () => {
  const h = await startTestHearth({
    linkedWorktree: true,
    projectRepositoryRegistryRoot: (home) => join(home, "incomplete-registry"),
  });
  opened.push(h);
  if (!h.main) throw new Error("the linked-worktree fixture needs a main root");

  const leakedName = "valid-only-in-real-root";
  mkdirSync(join(h.main, "repos", leakedName, ".git"), { recursive: true });
  writeFileSync(
    join(h.main, "repos", "repos.json"),
    JSON.stringify({
      repos: [
        {
          name: leakedName,
          url: "https://example.invalid/real-root-only",
          defaultBranch: "main",
        },
      ],
    }),
  );
  const incompleteRoot = join(h.home, "incomplete-registry");
  mkdirSync(join(incompleteRoot, "repos"), { recursive: true });
  writeFileSync(
    join(incompleteRoot, "repos", "repos.json"),
    JSON.stringify({
      repos: [
        {
          name: "missing-checkout",
          url: "https://example.invalid/missing-checkout",
          defaultBranch: "main",
        },
      ],
    }),
  );

  const before = createProjectStore(h.home).read();
  const response = await fetch(`${h.api}/projects/create-options`, {
    headers: h.headers(h.hearth.token),
  });
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({ ok: false, data: null });
  expect(createProjectStore(h.home).read()).toEqual(before);
  expect(createProjectStore(h.home).listCreates()).toEqual([]);
  expect(h.events(["operator.action"])).toEqual([]);
});

test("project-create options refuse malformed, oversized, or over-cap choice sources", async () => {
  const malformed = await startTestHearth({
    files: { "repos/repos.json": "{invalid" },
  });
  opened.push(malformed);
  const malformedResponse = await fetch(
    `${malformed.api}/projects/create-options`,
    { headers: malformed.headers(malformed.hearth.token) },
  );
  expect(malformedResponse.status).toBe(503);

  const oversizedRegistry = await startTestHearth({
    files: {
      "repos/repos.json": `${JSON.stringify({ repos: [] })}${" ".repeat(65_536)}`,
    },
  });
  opened.push(oversizedRegistry);
  const registryBytesResponse = await fetch(
    `${oversizedRegistry.api}/projects/create-options`,
    { headers: oversizedRegistry.headers(oversizedRegistry.hearth.token) },
  );
  expect(registryBytesResponse.status).toBe(503);

  const tooManyRepos = await startTestHearth({
    files: {
      "repos/repos.json": JSON.stringify({
        repos: Array.from({ length: 128 }, (_, index) => ({
          name: `repo-${index}`,
          url: "https://example.invalid/repo",
          defaultBranch: "main",
        })),
      }),
    },
  });
  opened.push(tooManyRepos);
  const repoLimitResponse = await fetch(
    `${tooManyRepos.api}/projects/create-options`,
    { headers: tooManyRepos.headers(tooManyRepos.hearth.token) },
  );
  expect(repoLimitResponse.status).toBe(503);

  const tooManyEpics = await startTestHearth();
  opened.push(tooManyEpics);
  tooManyEpics.bd.answer = (args) =>
    args[0] === "export"
      ? {
          status: 0,
          stdout: Array.from({ length: 4_097 }, (_, index) =>
            JSON.stringify({
              id: `epic-${index}`,
              title: `Epic ${index}`,
              issue_type: "epic",
              priority: 2,
              status: "open",
              created_at: "2026-10-26T00:00:00.000Z",
              updated_at: "2026-10-26T00:00:00.000Z",
            }),
          ).join("\n"),
          stderr: "",
        }
      : undefined;
  const epicLimitResponse = await fetch(
    `${tooManyEpics.api}/projects/create-options`,
    { headers: tooManyEpics.headers(tooManyEpics.hearth.token) },
  );
  expect(epicLimitResponse.status).toBe(503);

  const oversized = await startTestHearth();
  opened.push(oversized);
  oversized.bd.answer = (args) =>
    args[0] === "export"
      ? {
          status: 0,
          stdout: Array.from({ length: 1_200 }, (_, index) =>
            JSON.stringify({
              id: `large-epic-${index}`,
              title: "x".repeat(1_000),
              issue_type: "epic",
              priority: 2,
              status: "open",
              created_at: "2026-10-26T00:00:00.000Z",
              updated_at: "2026-10-26T00:00:00.000Z",
            }),
          ).join("\n"),
          stderr: "",
        }
      : undefined;
  const byteLimitResponse = await fetch(
    `${oversized.api}/projects/create-options`,
    { headers: oversized.headers(oversized.hearth.token) },
  );
  expect(byteLimitResponse.status).toBe(503);
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
