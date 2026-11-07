import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import type { WorktreeEntry } from "../../../types/beads";
import type { ProjectCatalog } from "../../../types/projects";
import { resolveCheckout } from "../../ledger/workspace";
import { projectScopePreviewSettingsQuerySchema } from "../../projects/project-scope-preview-protocol";
import { workspaceKey } from "../../projects/scope";
import { createProjectStore, projectCatalogPath } from "../../projects/store";
import { projectCatalogFixture } from "../../projects/testing";
import { withQueueLock } from "../../scheduler/queue-lock";
import { startTestHearth, type TestHearth } from "../testing";
import { writeOwnerOnly } from "../token";
import { projectRoutes } from "./projects";

const opened: TestHearth[] = [];

function directScopePreview(
  h: TestHearth,
  snapshot: {
    catalog: ProjectCatalog;
    source: import("../../projects/summary").ProjectSources;
  },
  id: string,
  revision: number,
  epicIds: string[] = ["scope-preview-epic"],
) {
  const routes = projectRoutes(h.home, {
    root: h.root,
    workspace: h.workspace,
    loadScope: async () => snapshot,
  });
  const route = routes.settingsScopePreview;
  const query = new URLSearchParams([["revision", String(revision)]]);
  for (const epicId of epicIds) query.append("epicId", epicId);
  const parsed = route.validate({
    params: { id },
    query,
    headers: {},
    body: undefined,
  });
  return parsed.ok
    ? route.read(parsed.value)
    : { status: 400, error: "invalid query" };
}

async function scopeFixture(h: TestHearth, slug = "scope-preview-causal") {
  const store = createProjectStore(h.home);
  const catalog = await store.create(
    {
      slug,
      name: "Scope Preview",
      description: "",
      icon: "S",
      workspaces: [
        {
          root: h.workspace,
          repositories: [h.workspace],
          epicIds: ["scope-preview-epic"],
        },
      ],
    },
    0,
  );
  const project = catalog.projects[0];
  if (!project) throw new Error("scope preview project fixture missing");
  h.bd.issues.set("scope-preview-epic", {
    id: "scope-preview-epic",
    title: "Scope preview epic",
    issue_type: "epic",
    priority: 2,
    status: "open",
    labels: ["project:" + slug],
    created_at: "2026-10-26T00:00:00.000Z",
    updated_at: "2026-10-26T00:00:00.000Z",
  });
  h.bd.issues.set("scope-preview-task", {
    id: "scope-preview-task",
    title: "Scope preview task",
    issue_type: "task",
    priority: 2,
    status: "open",
    labels: ["project:" + slug],
    dependencies: [
      {
        issue_id: "scope-preview-task",
        depends_on_id: "scope-preview-epic",
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
  return { store, catalog, project };
}
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

type ProjectRepositoriesRoute = ReturnType<
  typeof projectRoutes
>["projectRepositoriesRead"];

async function readProjectRepositories(
  route: ProjectRepositoriesRoute,
  id: string,
): Promise<{ status: number; data?: unknown; error?: string }> {
  const validation = route.validate({
    params: { id },
    query: new URLSearchParams(),
    headers: {},
    body: undefined,
  });
  if (!validation.ok) return { status: 400, error: validation.error };
  return route.read(validation.value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

test("POST /projects/:id/settings/general updates the current project through the protected route", async () => {
  const h = await startTestHearth();
  opened.push(h);
  const store = createProjectStore(h.home);
  const created = await store.create(
    {
      slug: "alpha",
      name: "Alpha",
      description: "Before",
      icon: "A",
      color: "blue",
      keeperSmith: "claude-master",
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
  const original = created.projects[0];
  if (!original) throw new Error("project fixture missing");
  const read = await fetch(`${h.api}/projects`, { headers: h.headers() });
  expect(read.status).toBe(200);
  expect(await read.json()).toEqual({ ok: true, data: created, error: null });

  const response = await fetch(
    `${h.api}/projects/${original.id}/settings/general`,
    {
      method: "POST",
      headers: h.headers(h.hearth.token),
      body: JSON.stringify({
        expectedRevision: created.revision,
        general: {
          name: "Alpha renamed",
          description: "Updated description",
          icon: "G",
          color: "green",
        },
      }),
    },
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    ok: true,
    error: null,
    data: {
      revision: created.revision + 1,
      projects: [
        {
          id: original.id,
          slug: original.slug,
          name: "Alpha renamed",
          description: "Updated description",
          icon: "G",
          color: "green",
          workspaces: original.workspaces,
          keeperSmith: original.keeperSmith,
          pinned: original.pinned,
          archived: original.archived,
          createdAt: original.createdAt,
        },
      ],
    },
  });
  expect(store.read().projects[0]).toMatchObject({
    id: original.id,
    slug: original.slug,
    name: "Alpha renamed",
    description: "Updated description",
    icon: "G",
    color: "green",
    workspaces: original.workspaces,
    keeperSmith: original.keeperSmith,
    pinned: original.pinned,
    archived: original.archived,
    createdAt: original.createdAt,
  });
  expect(h.events(["operator.action"])).toHaveLength(1);
  expect(h.events(["operator.action"])[0]?.payload).toMatchObject({
    action: "project.settings.general",
    target: original.id,
  });
});

test("General settings clear omitted color and reject stale or unknown input", async () => {
  const h = await startTestHearth();
  opened.push(h);
  const store = createProjectStore(h.home);
  const created = await store.create(
    {
      slug: "general-settings",
      name: "Before",
      description: "Before description",
      icon: "B",
      color: "blue",
      keeperSmith: "claude-master",
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
  const original = created.projects[0];
  if (!original) throw new Error("project fixture missing");
  const preferred = await store.preferences(original.id, created.revision, {
    pinned: true,
    archived: true,
  });
  const response = await fetch(
    `${h.api}/projects/${original.id}/settings/general`,
    {
      method: "POST",
      headers: h.headers(h.hearth.token),
      body: JSON.stringify({
        expectedRevision: preferred.revision,
        general: {
          name: "After",
          description: "After description",
          icon: "A",
        },
      }),
    },
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    ok: true,
    error: null,
    data: { revision: preferred.revision + 1 },
  });
  const updated = store.read().projects[0];
  if (!updated) throw new Error("updated project missing");
  expect(updated).toMatchObject({
    id: original.id,
    slug: original.slug,
    name: "After",
    description: "After description",
    icon: "A",
    workspaces: original.workspaces,
    keeperSmith: "claude-master",
    pinned: true,
    archived: true,
    createdAt: original.createdAt,
  });
  expect(updated).not.toHaveProperty("color");
  expect(h.events(["operator.action"])).toHaveLength(1);
  expect(h.events(["operator.action"])[0]?.payload).toMatchObject({
    action: "project.settings.general",
    target: original.id,
  });

  const stale = await fetch(
    `${h.api}/projects/${original.id}/settings/general`,
    {
      method: "POST",
      headers: h.headers(h.hearth.token),
      body: JSON.stringify({
        expectedRevision: preferred.revision,
        general: { name: "Stale", description: "", icon: "S" },
      }),
    },
  );
  expect(stale.status).toBe(409);
  expect(store.read().projects[0]).toEqual(updated);

  const absentId = "project-00000000-0000-4000-8000-000000000000";
  const absent = await fetch(`${h.api}/projects/${absentId}/settings/general`, {
    method: "POST",
    headers: h.headers(h.hearth.token),
    body: JSON.stringify({
      expectedRevision: store.read().revision,
      general: { name: "Missing", description: "", icon: "M" },
    }),
  });
  expect(absent.status).toBe(404);
  expect(store.read().projects[0]).toEqual(updated);
  const auditedCount = h.events(["operator.action"]).length;
  const invalid = await fetch(
    `${h.api}/projects/${original.id}/settings/general`,
    {
      method: "POST",
      headers: h.headers(h.hearth.token),
      body: JSON.stringify({
        expectedRevision: store.read().revision,
        general: {
          name: "Invalid",
          description: "",
          icon: "I",
          extra: true,
        },
      }),
    },
  );
  expect(invalid.status).toBe(400);
  expect(h.events(["operator.action"])).toHaveLength(auditedCount);
  expect(store.read().projects[0]).toEqual(updated);

  for (const color of [null, "ultraviolet"]) {
    const malformedColor = await fetch(
      `${h.api}/projects/${original.id}/settings/general`,
      {
        method: "POST",
        headers: h.headers(h.hearth.token),
        body: JSON.stringify({
          expectedRevision: store.read().revision,
          general: {
            name: "Invalid color",
            description: "",
            icon: "I",
            color,
          },
        }),
      },
    );
    expect(malformedColor.status).toBe(400);
    expect(h.events(["operator.action"])).toHaveLength(auditedCount);
    expect(store.read().projects[0]).toEqual(updated);
  }
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
  const afterReserve = createProjectStore(h.home).read();
  expect(afterReserve.revision).toBe(before.revision);
  expect(afterReserve.projects).toEqual(before.projects);
  expect(afterReserve.createOperations).toHaveLength(1);
  expect(createProjectStore(h.home).readCreate(requestId)).toMatchObject({
    requestId,
    requestHash: reserveEnvelope.data.requestHash,
    original,
    baseRevision: before.revision,
    scopeHash: preview.scopeHash,
    scopeCount: preview.scopeCount,
    state: "reserved",
    projectId: null,
    createdRevision: null,
  });

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
  expect(h.events(["operator.action"]).map((event) => event.payload)).toEqual([
    {
      action: "project.create.reserve",
      surface: "api",
      target: slug,
      family: "project-create",
      requestId,
      inputHash: reserveEnvelope.data.requestHash,
    },
    {
      action: "project.create.commit",
      surface: "api",
      target: requestId,
      family: "project-create",
      requestId,
      inputHash: reserveEnvelope.data.requestHash,
    },
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

test("an explicit project Keeper Smith round-trips through the protected create original and public record", async () => {
  const h = await startTestHearth();
  opened.push(h);
  h.bd.issues.set("alpha-epic", {
    id: "alpha-epic",
    title: "Onboarding epic",
    issue_type: "epic",
    priority: 2,
    status: "open",
    labels: ["project:keeper-choice"],
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
  const requestId = "07d87f5a-10ca-4d83-87f5-70b222b0fe2e";
  const original = {
    slug: "keeper-choice",
    name: "Keeper Choice",
    description: "",
    icon: "K",
    workspaces: [
      {
        root: h.workspace,
        repositories: [h.workspace],
        epicIds: ["alpha-epic"],
      },
    ],
    keeperSmith: "claude-master",
  };
  const headers = h.headers(h.hearth.token);
  const reserve = await fetch(`${h.api}/projects/create-reservations`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      requestId,
      expectedCatalogRevision: 0,
      original,
    }),
  });
  expect(reserve.status).toBe(201);
  const reserved: unknown = await reserve.json();
  expect(reserved).toMatchObject({
    ok: true,
    data: {
      requestId,
      original,
      state: "reserved",
    },
    error: null,
  });
  const reservation = createProjectStore(h.home).readCreate(requestId);
  expect(reservation?.original).toEqual(original);
  if (!reservation) throw new Error("Keeper project reservation missing");

  const exact = await fetch(
    `${h.api}/projects/create-reservations/${requestId}`,
    { headers },
  );
  expect(exact.status).toBe(200);
  expect(await exact.json()).toMatchObject({
    ok: true,
    data: { requestId, requestHash: reservation.requestHash, original },
    error: null,
  });
  const commit = await fetch(
    `${h.api}/projects/create-reservations/${requestId}/commit`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        requestHash: reservation.requestHash,
        reviewedScopeHash: reservation.scopeHash,
      }),
    },
  );
  expect(commit.status).toBe(200);
  expect(createProjectStore(h.home).read().projects[0]).toMatchObject({
    slug: original.slug,
    keeperSmith: original.keeperSmith,
  });
  const listed = await fetch(`${h.api}/projects`, { headers });
  expect(await listed.json()).toMatchObject({
    ok: true,
    data: {
      projects: [{ slug: original.slug, keeperSmith: original.keeperSmith }],
    },
    error: null,
  });
  expect(h.events(["operator.action"])).toHaveLength(2);
  const auditText = JSON.stringify(h.events(["operator.action"]));
  expect(auditText).not.toContain(original.keeperSmith);
  expect(auditText).not.toContain(original.name);
});

test("project color IDs round-trip through audited reservations without exposing the private identity", async () => {
  const h = await startTestHearth();
  opened.push(h);
  h.bd.issues.set("alpha-epic", {
    id: "alpha-epic",
    title: "Color project epic",
    issue_type: "epic",
    priority: 2,
    status: "open",
    labels: ["project:color-project"],
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
  const requestId = "15a475a2-62a7-4f96-8c42-f6feefcaef8a";
  const original = {
    slug: "color-project",
    name: "Color project",
    description: "A bounded presentation color",
    icon: "C",
    color: "green" as const,
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
    body: JSON.stringify({
      requestId,
      expectedCatalogRevision: 0,
      original,
    }),
  });
  expect(reserve.status).toBe(201);
  expect(await reserve.json()).toMatchObject({
    ok: true,
    data: { requestId, state: "reserved", original },
    error: null,
  });
  const reservation = createProjectStore(h.home).readCreate(requestId);
  expect(reservation?.original).toEqual(original);
  if (!reservation) throw new Error("Color project reservation missing");

  const exact = await fetch(
    `${h.api}/projects/create-reservations/${requestId}`,
    { headers },
  );
  expect(exact.status).toBe(200);
  expect(await exact.json()).toMatchObject({
    ok: true,
    data: {
      requestId,
      requestHash: reservation.requestHash,
      original,
      state: "reserved",
    },
    error: null,
  });
  const commit = await fetch(
    `${h.api}/projects/create-reservations/${requestId}/commit`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        requestHash: reservation.requestHash,
        reviewedScopeHash: reservation.scopeHash,
      }),
    },
  );
  expect(commit.status).toBe(200);
  expect(createProjectStore(h.home).read().projects[0]).toMatchObject({
    slug: original.slug,
    color: original.color,
  });
  const publicCatalog = await fetch(`${h.api}/projects`, { headers });
  const publicBody: unknown = await publicCatalog.json();
  expect(publicBody).toMatchObject({
    ok: true,
    data: { projects: [{ slug: original.slug, color: original.color }] },
    error: null,
  });
  expect(JSON.stringify(publicBody)).not.toContain("createOperations");
  expect(JSON.stringify(publicBody)).not.toContain(requestId);
  expect(h.events(["operator.action"])).toHaveLength(2);
  const auditText = JSON.stringify(h.events(["operator.action"]));
  expect(auditText).not.toContain(original.color);
  expect(auditText).not.toContain(original.name);

  const invalid = await fetch(`${h.api}/projects/create-reservations`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      requestId: "4a8511e2-776a-43b7-9a5e-a34132bf27d8",
      expectedCatalogRevision: 1,
      original: { ...original, slug: "invalid-color", color: "#dcf1e6" },
    }),
  });
  expect(invalid.status).toBe(400);
  expect(createProjectStore(h.home).read().createOperations).toHaveLength(1);
  expect(h.events(["operator.action"])).toHaveLength(2);
});

test("missing and disabled explicit Keeper names refuse before reserving a project", async () => {
  const h = await startTestHearth();
  opened.push(h);
  h.bd.issues.set("alpha-epic", {
    id: "alpha-epic",
    title: "Onboarding epic",
    issue_type: "epic",
    priority: 2,
    status: "open",
    labels: ["project:keeper-refusal"],
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
  const userConfig = join(h.configHome, ".agent-forge", "config.toml");
  mkdirSync(join(h.configHome, ".agent-forge"), { recursive: true });
  writeFileSync(
    userConfig,
    "[smiths.claude-master]\nenabled = false\n",
    "utf8",
  );
  const headers = h.headers(h.hearth.token);
  const choices = [
    { slug: "unknown-keeper", keeperSmith: "not-configured" },
    { slug: "disabled-keeper", keeperSmith: "claude-master" },
  ];
  for (const [index, choice] of choices.entries()) {
    const response = await fetch(`${h.api}/projects/create-reservations`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        requestId:
          index === 0
            ? "15f08589-6ab8-4a04-9c68-377c1cabed8c"
            : "bdbdf03a-843b-4833-89d4-2897b008aa88",
        expectedCatalogRevision: 0,
        original: {
          slug: choice.slug,
          name: choice.slug,
          description: "",
          icon: "K",
          workspaces: [
            {
              root: h.workspace,
              repositories: [h.workspace],
              epicIds: ["alpha-epic"],
            },
          ],
          keeperSmith: choice.keeperSmith,
        },
      }),
    });
    expect(response.status).toBe(400);
    const body: unknown = await response.json();
    expect(body).toMatchObject({ ok: false, data: null });
    const errorText = JSON.stringify(body).toLowerCase();
    expect(errorText).toMatch(
      choice.keeperSmith === "claude-master"
        ? /disabled|unavailable/
        : /unknown|configured|unavailable/,
    );
  }
  const store = createProjectStore(h.home);
  expect(store.read().projects).toEqual([]);
  expect(store.listCreates()).toEqual([]);
});

test("explicit Keeper configuration is revalidated after waiting for the project catalog writer", async () => {
  const h = await startTestHearth();
  opened.push(h);
  const issue = {
    id: "alpha-epic",
    title: "Keeper selection source",
    issue_type: "epic",
    priority: 2,
    status: "open",
    labels: ["project:keeper-config-race"],
    created_at: "2026-10-26T00:00:00.000Z",
    updated_at: "2026-10-26T00:00:00.000Z",
  };
  h.bd.issues.set(issue.id, issue);
  const initialRead = deferred<void>();
  h.bd.answer = (args) => {
    if (args[0] !== "export") return undefined;
    initialRead.resolve();
    return {
      status: 0,
      stdout: JSON.stringify(issue),
      stderr: "",
    };
  };
  const configDirectory = join(h.configHome, ".agent-forge");
  const userConfig = join(configDirectory, "config.toml");
  mkdirSync(configDirectory, { recursive: true });
  writeFileSync(userConfig, "[smiths.claude-master]\nenabled = true\n", "utf8");

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
  const requestId = "88267545-9b7d-4bb0-9a8a-e531004201ac";
  const responsePromise = fetch(`${h.api}/projects/create-reservations`, {
    method: "POST",
    headers: h.headers(h.hearth.token),
    body: JSON.stringify({
      requestId,
      expectedCatalogRevision: 0,
      original: {
        slug: "keeper-config-race",
        name: "Keeper Config Race",
        description: "",
        icon: "K",
        workspaces: [
          {
            root: h.workspace,
            repositories: [h.workspace],
            epicIds: ["alpha-epic"],
          },
        ],
        keeperSmith: "claude-master",
      },
    }),
  });
  try {
    await initialRead.promise;
    writeFileSync(
      userConfig,
      "[smiths.claude-master]\nenabled = false\n",
      "utf8",
    );
  } finally {
    unlock.resolve();
  }
  await writer;
  const response = await responsePromise;
  expect(response.status).toBe(400);
  const store = createProjectStore(h.home);
  expect(store.read().projects).toEqual([]);
  expect(store.readCreate(requestId)).toBeNull();
});

test("an explicit Keeper is revalidated before commit after configuration changes under the catalog lock", async () => {
  const h = await startTestHearth();
  opened.push(h);
  const issue = {
    id: "alpha-epic",
    title: "Keeper commit source",
    issue_type: "epic",
    priority: 2,
    status: "open",
    labels: ["project:keeper-commit-race"],
    created_at: "2026-10-26T00:00:00.000Z",
    updated_at: "2026-10-26T00:00:00.000Z",
  };
  h.bd.issues.set(issue.id, issue);
  h.bd.answer = (args) =>
    args[0] === "export"
      ? {
          status: 0,
          stdout: JSON.stringify(issue),
          stderr: "",
        }
      : undefined;
  const configDirectory = join(h.configHome, ".agent-forge");
  const userConfig = join(configDirectory, "config.toml");
  mkdirSync(configDirectory, { recursive: true });
  writeFileSync(userConfig, "[smiths.claude-master]\nenabled = true\n", "utf8");

  const requestId = "4f2e47b0-f594-4e08-82fa-f3cb92566747";
  const headers = h.headers(h.hearth.token);
  const reserve = await fetch(`${h.api}/projects/create-reservations`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      requestId,
      expectedCatalogRevision: 0,
      original: {
        slug: "keeper-commit-race",
        name: "Keeper Commit Race",
        description: "",
        icon: "K",
        workspaces: [
          {
            root: h.workspace,
            repositories: [h.workspace],
            epicIds: ["alpha-epic"],
          },
        ],
        keeperSmith: "claude-master",
      },
    }),
  });
  expect(reserve.status).toBe(201);
  const reserved: unknown = await reserve.json();
  expect(reserved).toMatchObject({ ok: true, error: null });
  const reservation = createProjectStore(h.home).readCreate(requestId);
  if (!reservation) throw new Error("Keeper reservation missing before commit");

  const initialRead = deferred<void>();
  h.bd.answer = (args) => {
    if (args[0] !== "export") return undefined;
    initialRead.resolve();
    return { status: 0, stdout: JSON.stringify(issue), stderr: "" };
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
      body: JSON.stringify({
        requestHash: reservation.requestHash,
        reviewedScopeHash: reservation.scopeHash,
      }),
    },
  );
  try {
    await initialRead.promise;
    writeFileSync(
      userConfig,
      "[smiths.claude-master]\nenabled = false\n",
      "utf8",
    );
  } finally {
    unlock.resolve();
  }
  await writer;
  const response = await responsePromise;
  expect(response.status).toBe(400);
  const store = createProjectStore(h.home);
  expect(store.read().projects).toEqual([]);
  expect(store.readCreate(requestId)).toMatchObject({
    requestHash: reservation.requestHash,
    state: "reserved",
  });
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

test("protected project scope preview starts from the current project revision", async () => {
  const h = await startTestHearth();
  opened.push(h);
  const { store, catalog, project } = await scopeFixture(h);

  const catalogRead = await fetch(`${h.api}/projects`, {
    headers: h.headers(h.hearth.token),
  });
  expect(catalogRead.status).toBe(200);
  expect(await catalogRead.json()).toEqual({
    ok: true,
    data: catalog,
    error: null,
  });
  const existingPreview = await fetch(
    `${h.api}/projects/create-scope-preview?slug=scope-preview-causal&epicId=scope-preview-epic`,
    { headers: h.headers(h.hearth.token) },
  );
  expect(existingPreview.status).toBe(200);
  const existingBody = (await existingPreview.json()) as {
    data: { scopeHash: string };
  };
  expect(existingBody).toMatchObject({
    data: { complete: true, scopeCount: 2 },
  });
  expect(store.read()).toEqual(catalog);
  const expectedHash = createHash("sha256")
    .update(
      JSON.stringify({
        workspace: workspaceKey(h.workspace),
        slug: "scope-preview-causal",
        epicIds: ["scope-preview-epic"],
        members: ["scope-preview-epic", "scope-preview-task"],
      }),
    )
    .digest("hex");
  expect(existingBody.data.scopeHash).toBe(expectedHash);

  const preview = await fetch(
    `${h.api}/projects/${project.id}/settings/scope-preview?revision=${catalog.revision}&epicId=scope-preview-epic`,
    { headers: h.headers(h.hearth.token) },
  );
  expect(preview.status).toBe(200);
  const body = await preview.json();
  expect(body).toEqual({
    ok: true,
    data: {
      complete: true,
      projectId: project.id,
      catalogRevision: catalog.revision,
      workspaceKey: workspaceKey(h.workspace),
      slug: project.slug,
      epicIds: ["scope-preview-epic"],
      scopeCount: 2,
      scopeHash: expectedHash,
      sourceAsOf: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    },
    error: null,
  });
  expect(Object.keys(body.data).sort()).toEqual([
    "catalogRevision",
    "complete",
    "epicIds",
    "projectId",
    "scopeCount",
    "scopeHash",
    "slug",
    "sourceAsOf",
    "workspaceKey",
  ]);
  expect(h.events(["operator.action"])).toEqual([]);
  expect(store.read()).toEqual(catalog);
});

test("settings scope preview rejects malformed queries before reading the tracker", async () => {
  const h = await startTestHearth();
  opened.push(h);
  const { project, catalog } = await scopeFixture(h);
  const prefix = "/projects/" + project.id + "/settings/scope-preview";
  const invalid = [
    "",
    "?revision=",
    "?revision=01",
    "?revision=-1",
    "?revision=1.0",
    "?revision=9007199254740992",
    "?revision=1&revision=1",
    "?revision=1&unknown=x",
    "?revision=1&epicId=",
    "?revision=1&epicId=%01",
    "?revision=1&epicId=scope-preview-epic&epicId=scope-preview-epic",
    "?revision=1&epicId=" + "x".repeat(201),
    "?revision=1&" +
      Array.from({ length: 65 }, (_, i) => "epicId=id-" + i).join("&"),
  ];
  for (const query of invalid) {
    const response = await fetch(h.api + prefix + query, {
      headers: h.headers(h.hearth.token),
    });
    expect(response.status).toBe(400);
  }
  const invalidId = await fetch(
    h.api + "/projects/not-a-project/settings/scope-preview?revision=1",
    { headers: h.headers(h.hearth.token) },
  );
  expect(invalidId.status).toBe(400);
  expect(h.bd.calls).toHaveLength(0);
  const maxSafe = await fetch(h.api + prefix + "?revision=9007199254740991", {
    headers: h.headers(h.hearth.token),
  });
  expect(maxSafe.status).toBe(409);
  const absent = await fetch(
    h.api +
      "/projects/project-00000000-0000-4000-8000-000000000000/settings/scope-preview?revision=1",
    { headers: h.headers(h.hearth.token) },
  );
  expect(absent.status).toBe(404);
  const stale = await fetch(
    h.api +
      prefix +
      "?revision=" +
      (catalog.revision - 1) +
      "&epicId=scope-preview-epic",
    { headers: h.headers(h.hearth.token) },
  );
  expect(stale.status).toBe(409);
});

test("settings scope preview counts only selected epic descendants with the fixed project label", async () => {
  const h = await startTestHearth();
  opened.push(h);
  const { project, catalog } = await scopeFixture(h, "scope-membership");
  h.bd.issues.set("scope-preview-unlabeled", {
    id: "scope-preview-unlabeled",
    title: "Unlabeled child",
    issue_type: "task",
    priority: 2,
    status: "open",
    labels: ["other"],
    dependencies: [
      {
        issue_id: "scope-preview-unlabeled",
        depends_on_id: "scope-preview-epic",
        type: "parent-child",
      },
    ],
    created_at: "2026-10-26T00:00:00.000Z",
    updated_at: "2026-10-26T00:00:00.000Z",
  });
  h.bd.issues.set("scope-preview-other-epic", {
    id: "scope-preview-other-epic",
    title: "Other epic",
    issue_type: "epic",
    priority: 2,
    status: "open",
    labels: ["project:scope-membership"],
    created_at: "2026-10-26T00:00:00.000Z",
    updated_at: "2026-10-26T00:00:00.000Z",
  });
  h.bd.issues.set("scope-preview-other-task", {
    id: "scope-preview-other-task",
    title: "Other child",
    issue_type: "task",
    priority: 2,
    status: "open",
    labels: ["project:scope-membership"],
    dependencies: [
      {
        issue_id: "scope-preview-other-task",
        depends_on_id: "scope-preview-other-epic",
        type: "parent-child",
      },
    ],
    created_at: "2026-10-26T00:00:00.000Z",
    updated_at: "2026-10-26T00:00:00.000Z",
  });
  const selectedOnly = await fetch(
    h.api +
      "/projects/" +
      project.id +
      "/settings/scope-preview?revision=" +
      catalog.revision +
      "&epicId=scope-preview-epic",
    { headers: h.headers(h.hearth.token) },
  );
  expect(selectedOnly.status).toBe(200);
  expect((await selectedOnly.json()).data.scopeCount).toBe(2);
  const response = await fetch(
    h.api +
      "/projects/" +
      project.id +
      "/settings/scope-preview?revision=" +
      catalog.revision +
      "&epicId=scope-preview-other-epic&epicId=scope-preview-epic",
    { headers: h.headers(h.hearth.token) },
  );
  expect(response.status).toBe(200);
  const result = await response.json();
  expect(result.data).toMatchObject({
    scopeCount: 4,
    epicIds: ["scope-preview-epic", "scope-preview-other-epic"],
  });
  const expectedHash = createHash("sha256")
    .update(
      JSON.stringify({
        workspace: workspaceKey(h.workspace),
        slug: "scope-membership",
        epicIds: ["scope-preview-epic", "scope-preview-other-epic"],
        members: [
          "scope-preview-epic",
          "scope-preview-other-epic",
          "scope-preview-other-task",
          "scope-preview-task",
        ],
      }),
    )
    .digest("hex");
  expect(result.data.scopeHash).toBe(expectedHash);
  const oldPreview = await fetch(
    h.api +
      "/projects/create-scope-preview?slug=scope-membership&epicId=scope-preview-epic&epicId=scope-preview-other-epic",
    { headers: h.headers(h.hearth.token) },
  );
  expect(oldPreview.status).toBe(200);
  expect(result.data.scopeHash).toBe((await oldPreview.json()).data.scopeHash);
});

test("a complete empty scope and empty candidate preview are known zero", async () => {
  const h = await startTestHearth();
  opened.push(h);
  const { project, catalog } = await scopeFixture(h);
  h.bd.issues.set("scope-preview-epic", {
    id: "scope-preview-epic",
    title: "No members",
    issue_type: "epic",
    priority: 2,
    status: "open",
    labels: [],
    created_at: "2026-10-26T00:00:00.000Z",
    updated_at: "2026-10-26T00:00:00.000Z",
  });
  h.bd.issues.set("scope-preview-task", {
    id: "scope-preview-task",
    title: "No member label",
    issue_type: "task",
    priority: 2,
    status: "open",
    labels: [],
    dependencies: [
      {
        issue_id: "scope-preview-task",
        depends_on_id: "scope-preview-epic",
        type: "parent-child",
      },
    ],
    created_at: "2026-10-26T00:00:00.000Z",
    updated_at: "2026-10-26T00:00:00.000Z",
  });
  const path =
    "/projects/" +
    project.id +
    "/settings/scope-preview?revision=" +
    catalog.revision;
  const selected = await fetch(h.api + path + "&epicId=scope-preview-epic", {
    headers: h.headers(h.hearth.token),
  });
  expect(selected.status).toBe(200);
  const selectedBody = await selected.json();
  expect(selectedBody.data).toMatchObject({
    complete: true,
    scopeCount: 0,
    epicIds: ["scope-preview-epic"],
  });
  const empty = await fetch(h.api + path, {
    headers: h.headers(h.hearth.token),
  });
  expect(empty.status).toBe(200);
  const emptyBody = await empty.json();
  expect(emptyBody.data).toMatchObject({
    complete: true,
    scopeCount: 0,
    epicIds: [],
  });
  expect(emptyBody.data.scopeHash).toMatch(/^[a-f0-9]{64}$/);
  const emptyHash = createHash("sha256")
    .update(
      JSON.stringify({
        workspace: workspaceKey(h.workspace),
        slug: "scope-preview-causal",
        epicIds: [],
        members: [],
      }),
    )
    .digest("hex");
  expect(emptyBody.data.scopeHash).toBe(emptyHash);
  const emptyAgain = await fetch(h.api + path, {
    headers: h.headers(h.hearth.token),
  });
  expect((await emptyAgain.json()).data.scopeHash).toBe(
    emptyBody.data.scopeHash,
  );
  expect(
    projectScopePreviewSettingsQuerySchema.safeParse({
      revision: 1,
      epicIds: ["bad\u0001"],
    }).success,
  ).toBe(false);
  expect(
    projectScopePreviewSettingsQuerySchema.safeParse({
      revision: 1,
      epicIds: ["bad\ud800"],
    }).success,
  ).toBe(false);
});
test("settings preview is revision-bound and reads only its one served workspace", async () => {
  const multiHearth = await startTestHearth();
  opened.push(multiHearth);
  const multi = await scopeFixture(multiHearth, "scope-multi");
  const multiCatalog = multi.store.read();
  const multiProject = multiCatalog.projects[0];
  if (!multiProject) throw new Error("multi-workspace fixture missing");
  multiCatalog.projects[0] = {
    ...multiProject,
    workspaces: [
      ...multiProject.workspaces,
      {
        root: join(multiHearth.root, "not-served"),
        repositories: [multiHearth.workspace],
        epicIds: ["scope-preview-epic"],
      },
    ],
  };
  writeOwnerOnly(
    projectCatalogPath(multiHearth.home),
    JSON.stringify(multiCatalog),
  );
  const multiResponse = await fetch(
    multiHearth.api +
      "/projects/" +
      multiProject.id +
      "/settings/scope-preview?revision=" +
      multiCatalog.revision +
      "&epicId=scope-preview-epic",
    { headers: multiHearth.headers(multiHearth.hearth.token) },
  );
  expect(multiResponse.status).toBe(409);

  const otherHearth = await startTestHearth();
  opened.push(otherHearth);
  const other = await scopeFixture(otherHearth, "scope-other-workspace");
  const otherCatalog = other.store.read();
  const otherProject = otherCatalog.projects[0];
  if (!otherProject) throw new Error("other-workspace fixture missing");
  otherCatalog.projects[0] = {
    ...otherProject,
    workspaces: [
      {
        ...otherProject.workspaces[0]!,
        root: join(otherHearth.root, "not-served"),
      },
    ],
  };
  writeOwnerOnly(
    projectCatalogPath(otherHearth.home),
    JSON.stringify(otherCatalog),
  );
  const otherResponse = await fetch(
    otherHearth.api +
      "/projects/" +
      otherProject.id +
      "/settings/scope-preview?revision=" +
      otherCatalog.revision +
      "&epicId=scope-preview-epic",
    { headers: otherHearth.headers(otherHearth.hearth.token) },
  );
  expect(otherResponse.status).toBe(409);

  const metadataHearth = await startTestHearth();
  opened.push(metadataHearth);
  const metadata = await scopeFixture(metadataHearth, "scope-metadata-only");
  const metadataCatalog = metadata.store.read();
  const metadataProject = metadataCatalog.projects[0];
  if (!metadataProject) throw new Error("repository metadata fixture missing");
  const absentRepository = join(
    metadataHearth.home,
    "absent-private-repository",
  );
  expect(existsSync(absentRepository)).toBe(false);
  metadataCatalog.projects[0] = {
    ...metadataProject,
    workspaces: [
      { ...metadataProject.workspaces[0]!, repositories: [absentRepository] },
    ],
  };
  writeOwnerOnly(
    projectCatalogPath(metadataHearth.home),
    JSON.stringify(metadataCatalog),
  );
  const metadataResponse = await fetch(
    metadataHearth.api +
      "/projects/" +
      metadataProject.id +
      "/settings/scope-preview?revision=" +
      metadataCatalog.revision +
      "&epicId=scope-preview-epic",
    { headers: metadataHearth.headers(metadataHearth.hearth.token) },
  );
  expect(metadataResponse.status).toBe(200);
  const metadataText = await metadataResponse.text();
  expect(metadataText).not.toContain(absentRepository);
  expect(createProjectStore(metadataHearth.home).read()).toEqual(
    metadataCatalog,
  );
});

test("a General revision change invalidates an older scope preview", async () => {
  const h = await startTestHearth();
  opened.push(h);
  const { store, project, catalog } = await scopeFixture(
    h,
    "scope-revision-bound",
  );
  const changed = await store.updateGeneral(project.id, catalog.revision, {
    name: "Changed",
    description: "",
    icon: "S",
  });
  const old = await fetch(
    h.api +
      "/projects/" +
      project.id +
      "/settings/scope-preview?revision=" +
      catalog.revision +
      "&epicId=scope-preview-epic",
    { headers: h.headers(h.hearth.token) },
  );
  expect(old.status).toBe(409);
  expect((await old.json()).data).toBeNull();
  const current = await fetch(
    h.api +
      "/projects/" +
      project.id +
      "/settings/scope-preview?revision=" +
      changed.revision +
      "&epicId=scope-preview-epic",
    { headers: h.headers(h.hearth.token) },
  );
  expect(current.status).toBe(200);
  expect((await current.json()).data.catalogRevision).toBe(changed.revision);
  expect(createProjectStore(h.home).read()).toEqual(changed);
});
test("snapshot workspace mismatch and incomplete issues fail closed", async () => {
  const h = await startTestHearth();
  opened.push(h);
  const { project, catalog } = await scopeFixture(h, "scope-source-mismatch");
  const source: import("../../projects/summary").ProjectSources = {
    workspace: join(h.root, "not-served"),
    asOf: "2026-10-31T23:00:00.000Z",
    issues: [
      {
        id: "scope-preview-epic",
        type: "epic",
        title: "Epic",
        status: "open",
        labels: ["project:scope-source-mismatch"],
        createdAt: "2026-10-31T00:00:00.000Z",
        updatedAt: "2026-10-31T00:00:00.000Z",
      },
    ],
    queue: null,
    sessions: [],
    sessionsComplete: false,
    problems: [],
    checkout: h.root,
  };
  const mismatch = await directScopePreview(
    h,
    { catalog, source },
    project.id,
    catalog.revision,
  );
  expect(mismatch.status).toBe(409);
  if ("data" in mismatch) expect(mismatch.data).toBeUndefined();
  expect("error" in mismatch ? mismatch.error : "").not.toContain("not-served");
  const incomplete = await directScopePreview(
    h,
    { catalog, source: { ...source, workspace: h.workspace, issues: null } },
    project.id,
    catalog.revision,
  );
  expect(incomplete.status).toBe(503);
});

test("catalog and tracker failures are private errors with target precedence", async () => {
  const h = await startTestHearth();
  opened.push(h);
  const { project, catalog } = await scopeFixture(h, "scope-fail-closed");
  h.bd.answer = () => ({
    status: 1,
    stdout: "",
    stderr: "private tracker detail",
  });
  const absent = await fetch(
    h.api +
      "/projects/project-00000000-0000-4000-8000-000000000000/settings/scope-preview?revision=0",
    { headers: h.headers(h.hearth.token) },
  );
  expect(absent.status).toBe(404);
  const stale = await fetch(
    h.api + "/projects/" + project.id + "/settings/scope-preview?revision=0",
    { headers: h.headers(h.hearth.token) },
  );
  expect(stale.status).toBe(409);
  const failed = await fetch(
    h.api +
      "/projects/" +
      project.id +
      "/settings/scope-preview?revision=" +
      catalog.revision +
      "&epicId=scope-preview-epic",
    { headers: h.headers(h.hearth.token) },
  );
  expect(failed.status).toBe(503);
  const failureText = await failed.text();
  expect(failureText).not.toContain("private tracker detail");
  expect(failureText).not.toContain(h.home);

  const catalogHearth = await startTestHearth();
  opened.push(catalogHearth);
  const catalogFixture = await scopeFixture(
    catalogHearth,
    "scope-invalid-catalog",
  );
  const privatePath = projectCatalogPath(catalogHearth.home);
  writeFileSync(privatePath, "not valid catalog: private marker");
  const invalidCatalog = await fetch(
    catalogHearth.api +
      "/projects/" +
      catalogFixture.project.id +
      "/settings/scope-preview?revision=" +
      catalogFixture.catalog.revision +
      "&epicId=scope-preview-epic",
    { headers: catalogHearth.headers(catalogHearth.hearth.token) },
  );
  expect(invalidCatalog.status).toBe(503);
  const invalidText = await invalidCatalog.text();
  expect(invalidText).not.toContain(privatePath);
  expect(invalidText).not.toContain("private marker");
});

test("partial malformed duplicate and timed-out tracker exports never become zero", async () => {
  const h = await startTestHearth({ api: { bdTimeoutMs: 10 } });
  opened.push(h);
  const { project, catalog } = await scopeFixture(h, "scope-bad-source");
  const row = JSON.stringify({
    id: "scope-preview-epic",
    title: "Epic",
    issue_type: "epic",
    status: "open",
    labels: ["project:scope-bad-source"],
  });
  const cases = [
    {
      label: "partial",
      result: { status: 0, stdout: row + "\nnot-json", stderr: "" },
    },
    {
      label: "malformed",
      result: {
        status: 0,
        stdout: JSON.stringify({ id: "bad", issue_type: "task" }),
        stderr: "",
      },
    },
    {
      label: "duplicate",
      result: { status: 0, stdout: row + "\n" + row, stderr: "" },
    },
  ];
  for (const item of cases) {
    h.bd.answer = () => item.result;
    const response = await fetch(
      h.api +
        "/projects/" +
        project.id +
        "/settings/scope-preview?revision=" +
        catalog.revision +
        "&epicId=scope-preview-epic",
      { headers: h.headers(h.hearth.token) },
    );
    expect({ label: item.label, status: response.status }).toEqual({
      label: item.label,
      status: 503,
    });
    expect((await response.text()).toLowerCase()).not.toContain(item.label);
  }
  h.bd.answer = () => {
    throw new Error("private tracker failure");
  };
  const thrown = await fetch(
    h.api +
      "/projects/" +
      project.id +
      "/settings/scope-preview?revision=" +
      catalog.revision +
      "&epicId=scope-preview-epic",
    { headers: h.headers(h.hearth.token) },
  );
  expect(thrown.status).toBe(503);
  expect(await thrown.text()).not.toContain("private tracker failure");
  h.bd.answer = () =>
    new Promise<{ status: number | null; stdout: string; stderr: string }>(
      () => {},
    );
  const timedOut = await fetch(
    h.api +
      "/projects/" +
      project.id +
      "/settings/scope-preview?revision=" +
      catalog.revision +
      "&epicId=scope-preview-epic",
    { headers: h.headers(h.hearth.token) },
  );
  expect(timedOut.status).toBe(503);
});

test("a selected epic absent from a complete export is a conflict", async () => {
  const h = await startTestHearth();
  opened.push(h);
  const { project, catalog } = await scopeFixture(h, "scope-missing-epic");
  const response = await fetch(
    h.api +
      "/projects/" +
      project.id +
      "/settings/scope-preview?revision=" +
      catalog.revision +
      "&epicId=missing-epic",
    { headers: h.headers(h.hearth.token) },
  );
  expect(response.status).toBe(409);
  expect((await response.json()).data).toBeNull();
});

test("GET /projects/:id/settings/repositories reads only the selected registered checkout through the protected hearth", async () => {
  const h = await startTestHearth();
  opened.push(h);
  const servedGit = spawnSync("git", ["init", "--quiet", h.root], {
    cwd: h.root,
    encoding: "utf8",
    windowsHide: true,
    timeout: 10_000,
  });
  if (servedGit.status !== 0)
    throw new Error(
      "isolated served checkout fixture failed: " + servedGit.stderr,
    );

  const checkout = join(h.root, "settings-repository-fixture");
  mkdirSync(checkout, { recursive: true });
  const initialized = spawnSync("git", ["init", "--quiet", checkout], {
    cwd: h.root,
    encoding: "utf8",
    windowsHide: true,
    timeout: 10_000,
  });
  if (initialized.status !== 0)
    throw new Error(
      "isolated repository fixture failed: " + initialized.stderr,
    );
  const canonical = realpathSync.native(checkout);
  const registryRoot = join(h.home, "project-create-registry");
  mkdirSync(registryRoot, { recursive: true });
  writeFileSync(
    join(registryRoot, "approved-repositories.json"),
    JSON.stringify({
      version: 1,
      repositories: [
        {
          name: "settings-repository-fixture",
          path: canonical,
          key: workspaceKey(canonical),
          originalRequestId: "a45b3815-cf25-4b2e-bab7-90b21e7732fd",
          source: "folder",
        },
      ],
    }),
  );

  const catalog = await createProjectStore(h.home).create(
    {
      slug: "settings-repository-fixture",
      name: "Settings repository fixture",
      description: "",
      icon: "S",
      workspaces: [
        {
          root: h.workspace,
          repositories: [canonical, h.workspace],
          epicIds: ["alpha-epic"],
        },
      ],
    },
    0,
  );
  const project = catalog.projects[0];
  if (!project) throw new Error("project fixture was not created");
  const persistedProject = createProjectStore(h.home)
    .read()
    .projects.find((candidate) => candidate.id === project.id);
  const persistedRepositories = persistedProject?.workspaces[0]?.repositories;
  if (!persistedRepositories || persistedRepositories.length !== 2)
    throw new Error("persisted project repository fixture missing");

  const catalogRead = await fetch(h.api + "/projects", {
    headers: h.headers(h.hearth.token),
  });
  expect(catalogRead.status).toBe(200);
  expect(await catalogRead.json()).toMatchObject({
    ok: true,
    data: { revision: catalog.revision, projects: [{ id: project.id }] },
    error: null,
  });

  const privateResponse = await fetch(
    h.api + "/projects/" + project.id + "/settings/repositories",
    { headers: h.headers() },
  );
  expect(privateResponse.status).toBe(403);
  const response = await fetch(
    h.api + "/projects/" + project.id + "/settings/repositories",
    { headers: h.headers(h.hearth.token) },
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    ok: true,
    data: {
      projectId: project.id,
      catalogRevision: catalog.revision,
      repositories: [
        {
          workspaceRoot: h.workspace,
          repositories: [
            {
              path: persistedRepositories[0]!,
              access: "approved",
              name: "settings-repository-fixture",
              worktrees: [],
            },
            {
              path: persistedRepositories[1]!,
              access: "served",
              name: basename(realpathSync.native(h.workspace)),
              worktrees: [],
            },
          ],
        },
      ],
    },
    error: null,
  });
});

test("project repository read resolves and requires the listed linked checkout", async () => {
  const h = await startTestHearth();
  opened.push(h);
  const main = join(h.root, "linked-main-fixture");
  const linked = join(h.root, "linked-checkout-fixture");
  mkdirSync(main, { recursive: true });
  const runGit = (args: string[]) => {
    const result = spawnSync("git", ["-C", main, ...args], {
      cwd: h.root,
      encoding: "utf8",
      windowsHide: true,
      timeout: 10_000,
    });
    if (result.status !== 0)
      throw new Error(
        "isolated linked-worktree fixture failed: " + result.stderr,
      );
  };
  runGit(["init", "--quiet"]);
  writeFileSync(join(main, "fixture.txt"), "fixture");
  runGit(["add", "fixture.txt"]);
  runGit([
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "fixture",
  ]);
  runGit(["worktree", "add", "--quiet", "-b", "settings-feature", linked]);
  const canonicalLinked = realpathSync.native(linked);
  const canonicalMain = realpathSync.native(main);
  const registryRoot = join(h.home, "linked-project-registry");
  mkdirSync(registryRoot, { recursive: true });
  writeFileSync(
    join(registryRoot, "approved-repositories.json"),
    JSON.stringify({
      version: 1,
      repositories: [
        {
          name: "linked-checkout-fixture",
          path: canonicalLinked,
          key: workspaceKey(canonicalLinked),
          originalRequestId: "d45b3815-cf25-4b2e-bab7-90b21e7732fd",
          source: "folder",
        },
      ],
    }),
  );
  const store = createProjectStore(h.home);
  const catalog = await store.create(
    {
      slug: "linked-project-fixture",
      name: "Linked project fixture",
      description: "",
      icon: "L",
      workspaces: [
        {
          root: h.workspace,
          repositories: [canonicalLinked],
          epicIds: ["alpha-epic"],
        },
      ],
    },
    0,
  );
  const project = catalog.projects[0];
  if (!project) throw new Error("linked project fixture missing");
  const persistedCatalog = store.read();
  const persistedProject = persistedCatalog.projects.find(
    (candidate) => candidate.id === project.id,
  );
  if (!persistedProject)
    throw new Error("persisted linked project fixture missing");
  persistedProject.workspaces[0]!.repositories = [canonicalLinked];
  writeFileSync(
    join(h.home, "projects", "catalog.json"),
    JSON.stringify(persistedCatalog),
  );
  const preservedProject = store
    .read()
    .projects.find((candidate) => candidate.id === project.id);
  expect(preservedProject?.workspaces[0]?.repositories).toEqual([
    canonicalLinked,
  ]);

  const route = projectRoutes(h.home, {
    root: h.root,
    workspace: h.workspace,
    repositoryManifestRoot: registryRoot,
    loadScope: async () => {
      throw new Error("unused project scope reader");
    },
  }).projectRepositoriesRead;
  const linkedRead = await readProjectRepositories(route, project.id);
  expect(linkedRead.status).toBe(200);
  const data = linkedRead.data;
  if (!isRecord(data) || !Array.isArray(data["repositories"]))
    throw new Error("linked repository response is malformed");
  const row: unknown = data["repositories"][0];
  if (!isRecord(row) || !Array.isArray(row["repositories"]))
    throw new Error("linked repository row is malformed");
  const linkedRepository: unknown = row["repositories"][0];
  if (
    !isRecord(linkedRepository) ||
    !Array.isArray(linkedRepository["worktrees"])
  )
    throw new Error("linked repository member is malformed");
  const linkedWorktree: unknown = linkedRepository["worktrees"][0];
  if (!isRecord(linkedWorktree) || typeof linkedWorktree["path"] !== "string")
    throw new Error("linked worktree row is malformed");
  expect(linkedRepository).toMatchObject({
    path: canonicalLinked,
    access: "approved",
    worktrees: [
      {
        kind: "other",
        branch: "settings-feature",
        missing: false,
      },
    ],
  });
  expect(workspaceKey(linkedWorktree["path"])).toBe(
    workspaceKey(canonicalLinked),
  );
  expect(linkedWorktree).not.toHaveProperty("id");
  expect(linkedWorktree).not.toHaveProperty("createdAt");

  const entry = (
    path: string,
    kind: WorktreeEntry["kind"],
    branch: string | null,
    missing: boolean,
  ): WorktreeEntry => ({
    path,
    kind,
    branch,
    head: "private-head",
    detached: false,
    locked: false,
    prunable: false,
    missing,
  });
  const injectedRoute = (mode: "absent" | "duplicate-missing") =>
    projectRoutes(h.home, {
      root: h.root,
      workspace: h.workspace,
      repositoryManifestRoot: registryRoot,
      listProjectWorktrees: () => ({
        ok: true,
        entries: [
          entry(canonicalMain, "main", "main", false),
          ...(mode === "absent"
            ? []
            : [entry(canonicalLinked, "other", "settings-feature", false)]),
          ...(mode === "duplicate-missing"
            ? [entry(canonicalLinked, "other", "settings-feature", true)]
            : []),
        ],
      }),
      loadScope: async () => {
        throw new Error("unused project scope reader");
      },
    }).projectRepositoriesRead;
  expect(
    (await readProjectRepositories(injectedRoute("absent"), project.id)).status,
  ).toBe(503);
  expect(
    (
      await readProjectRepositories(
        injectedRoute("duplicate-missing"),
        project.id,
      )
    ).status,
  ).toBe(503);
});

test("project repository worktree totals and response bytes are bounded", async () => {
  const h = await startTestHearth();
  opened.push(h);
  const checkouts = ["settings-limit-one", "settings-limit-two"].map((name) => {
    const path = join(h.root, name);
    mkdirSync(path, { recursive: true });
    const initialized = spawnSync("git", ["init", "--quiet", path], {
      cwd: h.root,
      encoding: "utf8",
      windowsHide: true,
      timeout: 10_000,
    });
    if (initialized.status !== 0)
      throw new Error(
        "isolated repository fixture failed: " + initialized.stderr,
      );
    return realpathSync.native(path);
  });
  const registryRoot = join(h.home, "settings-limit-registry");
  mkdirSync(registryRoot, { recursive: true });
  writeFileSync(
    join(registryRoot, "approved-repositories.json"),
    JSON.stringify({
      version: 1,
      repositories: checkouts.map((path, index) => ({
        name: "settings-limit-" + index,
        path,
        key: workspaceKey(path),
        originalRequestId:
          (index ? "e45b3815" : "f45b3815") + "-cf25-4b2e-bab7-90b21e7732fd",
        source: "folder",
      })),
    }),
  );
  const catalog = await createProjectStore(h.home).create(
    {
      slug: "settings-limit-project",
      name: "Settings limit project",
      description: "",
      icon: "B",
      workspaces: [
        { root: h.workspace, repositories: checkouts, epicIds: ["alpha-epic"] },
      ],
    },
    0,
  );
  const project = catalog.projects[0];
  if (!project) throw new Error("settings limit project fixture missing");
  let count = 2048;
  let largeFields = false;
  const entry = (path: string, kind: WorktreeEntry["kind"]): WorktreeEntry => ({
    path,
    kind,
    branch: null,
    head: "private-head",
    detached: false,
    locked: false,
    prunable: false,
    missing: false,
  });
  const route = projectRoutes(h.home, {
    root: h.root,
    workspace: h.workspace,
    repositoryManifestRoot: registryRoot,
    listProjectWorktrees: (main) => ({
      ok: true,
      entries: [
        entry(main, "main"),
        ...Array.from({ length: count }, (_, index) =>
          entry(largeFields ? "p".repeat(1024) : "fixture/" + index, "trees"),
        ).map((row) =>
          largeFields ? { ...row, branch: "b".repeat(1024) } : row,
        ),
      ],
    }),
    loadScope: async () => {
      throw new Error("unused project scope reader");
    },
  }).projectRepositoriesRead;

  const exactTotal = await readProjectRepositories(route, project.id);
  expect(exactTotal.status).toBe(200);
  expect(
    (
      exactTotal.data as {
        repositories: Array<{ repositories: Array<{ worktrees: unknown[] }> }>;
      }
    ).repositories[0]?.repositories.reduce(
      (sum, repository) => sum + repository.worktrees.length,
      0,
    ),
  ).toBe(4096);
  count = 2049;
  expect((await readProjectRepositories(route, project.id)).status).toBe(503);
  count = 260;
  largeFields = true;
  expect((await readProjectRepositories(route, project.id)).status).toBe(503);
});

test("project repository read is bounded to registered membership and fails closed on incomplete Git facts", async () => {
  const h = await startTestHearth();
  opened.push(h);
  const checkout = join(h.root, "settings-read-repository");
  mkdirSync(checkout, { recursive: true });
  const initialized = spawnSync("git", ["init", "--quiet", checkout], {
    cwd: h.root,
    encoding: "utf8",
    windowsHide: true,
    timeout: 10_000,
  });
  if (initialized.status !== 0)
    throw new Error(
      "isolated repository fixture failed: " + initialized.stderr,
    );
  const canonical = realpathSync.native(checkout);
  const registryRoot = join(h.home, "project-create-registry");
  mkdirSync(registryRoot, { recursive: true });
  const registryPath = join(registryRoot, "approved-repositories.json");
  const unselectedRegisteredPath = join(h.root, "registered-but-not-a-member");
  const registration = {
    name: "settings-read-repository",
    path: canonical,
    key: workspaceKey(canonical),
    originalRequestId: "a45b3815-cf25-4b2e-bab7-90b21e7732fd",
    source: "folder",
  } as const;
  const notSelectedRegistration = {
    name: "not-selected",
    path: unselectedRegisteredPath,
    key: workspaceKey(unselectedRegisteredPath),
    originalRequestId: "b45b3815-cf25-4b2e-bab7-90b21e7732fd",
    source: "folder",
  } as const;
  const validRegistry = JSON.stringify({
    version: 1,
    repositories: [registration, notSelectedRegistration],
  });
  writeFileSync(registryPath, validRegistry);
  const unregisteredPath = join(h.root, "not-registered-and-absent");
  const store = createProjectStore(h.home);
  const catalog = await store.create(
    {
      slug: "settings-read-project",
      name: "Settings read project",
      description: "",
      icon: "S",
      workspaces: [
        {
          root: h.workspace,
          repositories: [canonical, unregisteredPath],
          epicIds: ["alpha-epic"],
        },
      ],
    },
    0,
  );
  const project = catalog.projects[0];
  if (!project) throw new Error("project fixture was not created");
  const persistedCatalog = store.read();
  const persistedProject = persistedCatalog.projects.find(
    (candidate) => candidate.id === project.id,
  );
  if (!persistedProject)
    throw new Error("persisted bounded project fixture missing");
  const approvedMemberPath = persistedProject.workspaces[0]?.repositories[0];
  if (!approvedMemberPath)
    throw new Error("approved project member fixture missing");
  persistedProject.workspaces[0]!.repositories = [
    approvedMemberPath,
    unregisteredPath,
  ];
  writeFileSync(
    join(h.home, "projects", "catalog.json"),
    JSON.stringify(persistedCatalog),
  );
  const exactMembers = store
    .read()
    .projects.find((candidate) => candidate.id === project.id)
    ?.workspaces[0]?.repositories;
  expect(exactMembers).toEqual([approvedMemberPath, unregisteredPath]);
  expect(exactMembers).not.toContain(workspaceKey(h.workspace));
  const calls: string[] = [];
  let listingMode:
    | "complete"
    | "main-only"
    | "error"
    | "throw"
    | "empty"
    | "wrong-main"
    | "mismatched-main" = "complete";
  const mainEntry = (main: string): WorktreeEntry => ({
    path: main,
    kind: "main",
    branch: "main",
    head: "private-head",
    detached: false,
    locked: false,
    prunable: false,
    missing: false,
  });
  const cachedTree = (main: string): WorktreeEntry => ({
    path: join(main, "trees", "cached-worktree"),
    kind: "trees",
    branch: null,
    head: "private-head",
    detached: false,
    locked: false,
    prunable: false,
    missing: true,
    id: "abc123",
    createdAt: "2026-10-30T12:00:00.000Z",
    beadId: "private-bead",
    sessionId: "private-session",
  });
  const route = projectRoutes(h.home, {
    root: h.root,
    workspace: h.workspace,
    repositoryManifestRoot: registryRoot,
    listProjectWorktrees: (main) => {
      calls.push(main);
      if (listingMode === "error")
        return { ok: false, error: "private git failure" };
      if (listingMode === "throw") throw new Error("private thrown failure");
      if (listingMode === "empty") return { ok: true, entries: [] };
      if (listingMode === "wrong-main")
        return { ok: true, entries: [{ ...mainEntry(main), kind: "other" }] };
      if (listingMode === "mismatched-main")
        return {
          ok: true,
          entries: [{ ...mainEntry(unselectedRegisteredPath), kind: "main" }],
        };
      if (listingMode === "main-only")
        return { ok: true, entries: [mainEntry(main)] };
      return { ok: true, entries: [mainEntry(main), cachedTree(main)] };
    },
    loadScope: async () => {
      throw new Error("unused project scope reader");
    },
  }).projectRepositoriesRead;

  const success = await readProjectRepositories(route, project.id);
  expect(success.status).toBe(200);
  expect(success.data).toEqual({
    projectId: project.id,
    catalogRevision: catalog.revision,
    repositories: [
      {
        workspaceRoot: h.workspace,
        repositories: [
          {
            path: approvedMemberPath,
            access: "approved",
            name: registration.name,
            worktrees: [
              {
                path: join(canonical, "trees", "cached-worktree"),
                kind: "trees",
                branch: null,
                missing: true,
                id: "abc123",
                createdAt: "2026-10-30T12:00:00.000Z",
              },
            ],
          },
          { path: unregisteredPath, access: "unregistered" },
        ],
      },
    ],
  });
  expect(calls).toHaveLength(1);
  expect(workspaceKey(calls[0] ?? "")).toBe(workspaceKey(canonical));
  expect(JSON.stringify(success.data)).not.toContain("private-head");
  expect(JSON.stringify(success.data)).not.toContain("private-bead");
  expect(JSON.stringify(success.data)).not.toContain("private-session");
  expect(JSON.stringify(success.data)).not.toContain(unselectedRegisteredPath);
  expect(JSON.stringify(success.data)).not.toContain('"access":"served"');
  expect(calls).not.toContain(unselectedRegisteredPath);

  listingMode = "main-only";
  const genuineEmptyWorktrees = await readProjectRepositories(
    route,
    project.id,
  );
  expect(genuineEmptyWorktrees.status).toBe(200);
  expect(genuineEmptyWorktrees.data).toMatchObject({
    repositories: [
      {
        repositories: [
          { path: approvedMemberPath, access: "approved", worktrees: [] },
          { path: unregisteredPath, access: "unregistered" },
        ],
      },
    ],
  });
  for (const mode of [
    "error",
    "throw",
    "empty",
    "wrong-main",
    "mismatched-main",
  ] as const) {
    listingMode = mode;
    const unavailable = await readProjectRepositories(route, project.id);
    expect(unavailable.status).toBe(503);
    expect(unavailable.error).not.toContain("private");
  }

  const invalidId = await readProjectRepositories(route, "not-a-project-id");
  expect(invalidId.status).toBe(400);
  const absentId = await readProjectRepositories(
    route,
    "project-00000000-0000-4000-8000-000000000000",
  );
  expect(absentId.status).toBe(404);

  listingMode = "complete";
  const malformedCatalogPath = join(h.home, "projects", "catalog.json");
  const savedCatalog = readFileSync(malformedCatalogPath, "utf8");
  writeFileSync(malformedCatalogPath, "{malformed");
  expect((await readProjectRepositories(route, project.id)).status).toBe(503);
  writeFileSync(malformedCatalogPath, savedCatalog);

  writeFileSync(registryPath, "{malformed");
  expect((await readProjectRepositories(route, project.id)).status).toBe(503);
  writeFileSync(
    registryPath,
    JSON.stringify({
      version: 1,
      repositories: [{ ...registration, key: registration.key + "-forged" }],
    }),
  );
  expect((await readProjectRepositories(route, project.id)).status).toBe(503);
  const alternateSpelling = registration.path + "/";
  expect(workspaceKey(alternateSpelling)).toBe(workspaceKey(registration.path));
  writeFileSync(
    registryPath,
    JSON.stringify({
      version: 1,
      repositories: [
        registration,
        { ...registration, path: alternateSpelling },
      ],
    }),
  );
  expect(
    store.read().projects.find((candidate) => candidate.id === project.id)
      ?.workspaces[0]?.repositories,
  ).toEqual([approvedMemberPath, unregisteredPath]);
  expect((await readProjectRepositories(route, project.id)).status).toBe(503);
  writeFileSync(registryPath, validRegistry);

  const invalidCheckout = join(canonical, "registered-invalid-git-checkout");
  mkdirSync(join(invalidCheckout, ".git"), { recursive: true });
  const invalidRegistration = {
    name: "invalid-git-checkout",
    path: invalidCheckout,
    key: workspaceKey(invalidCheckout),
    originalRequestId: "c45b3815-cf25-4b2e-bab7-90b21e7732fd",
    source: "folder",
  } as const;
  writeFileSync(
    registryPath,
    JSON.stringify({
      version: 1,
      repositories: [registration, invalidRegistration],
    }),
  );
  const invalidGitCatalog = JSON.parse(savedCatalog) as ProjectCatalog;
  const invalidGitProject = invalidGitCatalog.projects.find(
    (candidate) => candidate.id === project.id,
  );
  if (!invalidGitProject) throw new Error("saved project fixture missing");
  invalidGitProject.workspaces[0]!.repositories = [invalidCheckout];
  writeFileSync(malformedCatalogPath, JSON.stringify(invalidGitCatalog));
  const callsBeforeInvalidGit = calls.length;
  expect((await readProjectRepositories(route, project.id)).status).toBe(503);
  expect(calls).toHaveLength(callsBeforeInvalidGit);
  writeFileSync(malformedCatalogPath, savedCatalog);
  writeFileSync(registryPath, validRegistry);

  const duplicateCatalog = JSON.parse(savedCatalog) as ProjectCatalog;
  const duplicateProject = duplicateCatalog.projects.find(
    (candidate) => candidate.id === project.id,
  );
  if (!duplicateProject) throw new Error("saved project fixture missing");
  const duplicateMemberPath = approvedMemberPath + "/";
  expect(workspaceKey(duplicateMemberPath)).toBe(
    workspaceKey(approvedMemberPath),
  );
  duplicateProject.workspaces[0]!.repositories.push(duplicateMemberPath);
  writeFileSync(malformedCatalogPath, JSON.stringify(duplicateCatalog));
  const duplicateRead = store
    .read()
    .projects.find((candidate) => candidate.id === project.id);
  expect(duplicateRead?.workspaces[0]?.repositories).toEqual([
    approvedMemberPath,
    unregisteredPath,
    duplicateMemberPath,
  ]);
  expect((await readProjectRepositories(route, project.id)).status).toBe(503);
  writeFileSync(malformedCatalogPath, savedCatalog);

  renameSync(checkout, checkout + ".gone");
  expect((await readProjectRepositories(route, project.id)).status).toBe(503);
});

test("project budget settings persist and read scoped admission costs without inventing provider spend", async () => {
  const h = await startTestHearth();
  opened.push(h);
  const catalog = projectCatalogFixture(h.workspace),
    id = catalog.projects[0]!.id;
  writeOwnerOnly(projectCatalogPath(h.home), JSON.stringify(catalog));
  const path = `${h.api}/projects/${id}/settings/budgets`;
  const save = (expectedRevision: number, budgets: unknown) =>
    fetch(path, {
      method: "POST",
      headers: h.headers(h.hearth.token),
      body: JSON.stringify({ expectedRevision, budgets }),
    });
  expect(
    (await save(1, { shiftSpendCapUsd: 5, dailyApiKeyCapUsd: 10 })).status,
  ).toBe(200);
  const read = await fetch(path, { headers: h.headers(h.hearth.token) });
  expect(read.status).toBe(200);
  expect(await read.json()).toMatchObject({
    ok: true,
    data: {
      projectId: id,
      dailyCapUsd: 10,
      reportedUsd: 0,
      estimatedUsd: 0,
      reservedUsd: 0,
      unknownCount: 0,
    },
    error: null,
  });
  expect(
    (await save(1, { shiftSpendCapUsd: null, dailyApiKeyCapUsd: null })).status,
  ).toBe(409);
  expect(
    (await save(2, { shiftSpendCapUsd: -1, dailyApiKeyCapUsd: null })).status,
  ).toBe(400);
  expect(
    (await save(2, { shiftSpendCapUsd: null, dailyApiKeyCapUsd: null })).status,
  ).toBe(200);
  expect(createProjectStore(h.home).read().projects[0]?.budgets).toEqual({
    shiftSpendCapUsd: null,
    dailyApiKeyCapUsd: null,
  });
});

test("session default save validates enabled Claude Smiths and clears inheritance independently", async () => {
  const h = await startTestHearth();
  opened.push(h);
  const catalog = projectCatalogFixture(h.workspace);
  catalog.projects[0]!.keeperAutonomy = "suggest-only";
  writeOwnerOnly(projectCatalogPath(h.home), JSON.stringify(catalog));
  const directory = join(h.configHome, ".agent-forge");
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, "config.toml"),
    "[smiths.claude-master]\nenabled = false\n",
  );
  const path =
    h.api + "/projects/" + catalog.projects[0]!.id + "/settings/defaults";
  const save = (revision: number, defaults: unknown) =>
    fetch(path, {
      method: "POST",
      headers: h.headers(h.hearth.token),
      body: JSON.stringify({ expectedRevision: revision, defaults }),
    });
  for (const name of ["unknown", "claude-master", "codex-journeyman"])
    expect((await save(1, { claudeSessionSmith: name })).status).toBe(400);
  const store = createProjectStore(h.home);
  expect(store.read()).toEqual(catalog);
  expect(
    (await save(1, { claudeSessionSmith: "claude-journeyman" })).status,
  ).toBe(200);
  expect(store.read().projects[0]).toMatchObject({
    claudeSessionSmith: "claude-journeyman",
    keeperAutonomy: "suggest-only",
  });
  expect((await save(1, {})).status).toBe(409);
  expect((await save(2, {})).status).toBe(200);
  expect(store.read().projects[0]?.claudeSessionSmith).toBeUndefined();
  for (const defaults of [
    { codexSessionSmith: "claude-journeyman" },
    { geminiSessionSmith: "codex-journeyman" },
    { sessionWhere: "arbitrary" },
    { sessionRunAs: "administrator" },
  ])
    expect((await save(3, defaults)).status).toBe(400);
  expect(
    (
      await save(3, {
        codexSessionSmith: "codex-journeyman",
        sessionWhere: "new",
        sessionRunAs: "chat",
      })
    ).status,
  ).toBe(200);
  expect(
    (await save(4, { claudeSessionSmith: "claude-journeyman" })).status,
  ).toBe(200);
  expect(store.read().projects[0]).toMatchObject({
    codexSessionSmith: "codex-journeyman",
    sessionWhere: "new",
    sessionRunAs: "chat",
  });
  expect(
    (
      await save(5, {
        codexSessionSmith: null,
        sessionWhere: null,
        sessionRunAs: null,
      })
    ).status,
  ).toBe(200);
  expect(store.read().projects[0]?.codexSessionSmith).toBeUndefined();
  expect(store.read().projects[0]?.sessionWhere).toBeUndefined();
  expect(store.read().projects[0]?.claudeSessionSmith).toBe(
    "claude-journeyman",
  );
});

test("Keeper default save rejects unconfigured and disabled Smiths without changing the catalog", async () => {
  const h = await startTestHearth();
  opened.push(h);
  const store = createProjectStore(h.home);
  const created = await store.create(
    {
      slug: "keeper-settings",
      name: "Keeper",
      description: "",
      icon: "K",
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
  const id = created.projects[0]!.id;
  const configDirectory = join(h.configHome, ".agent-forge");
  mkdirSync(configDirectory, { recursive: true });
  writeFileSync(
    join(configDirectory, "config.toml"),
    "[smiths.claude-master]\nenabled = false\n",
  );
  for (const name of ["not-configured", "claude-master"]) {
    const response = await fetch(
      h.api + "/projects/" + id + "/settings/keeper",
      {
        method: "POST",
        headers: h.headers(h.hearth.token),
        body: JSON.stringify({
          expectedRevision: 1,
          keeper: { keeperSmith: name },
        }),
      },
    );
    expect(response.status).toBe(400);
    expect(store.read()).toEqual(created);
  }
  const response = await fetch(h.api + "/projects/" + id + "/settings/keeper", {
    method: "POST",
    headers: h.headers(h.hearth.token),
    body: JSON.stringify({
      expectedRevision: 1,
      keeper: {
        keeperSmith: "codex-journeyman",
        keeperAutonomy: "suggest-only",
      },
    }),
  });
  expect(response.status).toBe(200);
  expect(store.read().projects[0]?.keeperSmith).toBe("codex-journeyman");
  expect(store.read().projects[0]?.keeperAutonomy).toBe("suggest-only");
  const invalid = await fetch(h.api + "/projects/" + id + "/settings/keeper", {
    method: "POST",
    headers: h.headers(h.hearth.token),
    body: JSON.stringify({
      expectedRevision: 2,
      keeper: { keeperAutonomy: "automatic" },
    }),
  });
  expect(invalid.status).toBe(400);
  const stale = await fetch(h.api + "/projects/" + id + "/settings/keeper", {
    method: "POST",
    headers: h.headers(h.hearth.token),
    body: JSON.stringify({ expectedRevision: 1, keeper: {} }),
  });
  expect(stale.status).toBe(409);
  expect(store.read().revision).toBe(2);
});
