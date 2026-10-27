import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import type { ProjectCatalog } from "../../../types/projects";
import { createProjectStore } from "../../projects/store";
import { startTestHearth, type TestHearth } from "../testing";
import { writeOwnerOnly } from "../token";

const opened: TestHearth[] = [];
afterEach(async () => {
  for (const h of opened.splice(0)) await h.close();
});

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
        { root: h.root, repositories: [h.root], epicIds: ["alpha-epic"] },
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
  const request = {
    requestId: "63e76212-2d32-4fe2-ab4f-f37a4c827e31",
    expectedCatalogRevision: 0,
    original: {
      slug: "onboarding-alpha",
      name: "Onboarding Alpha",
      description: "",
      icon: "A",
      workspaces: [
        { root: h.root, repositories: [h.root], epicIds: ["alpha-epic"] },
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
});
