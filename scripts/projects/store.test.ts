import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeOwnerOnly } from "../hearth/token";
import { createProjectStore } from "./store";

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
