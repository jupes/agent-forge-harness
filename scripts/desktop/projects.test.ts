import { expect, test } from "bun:test";
import { ProjectsHomeView } from "../../apps/desktop/src/ProjectsHome";
import {
  openProject,
  projectCards,
} from "../../apps/desktop/src/projects-model";
import { attrs, findAll, textOf } from "../dashboard/ds/vnode";
import { projectCatalogFixture, projectFixture } from "../projects/testing";

test("cards filter archived records, sort pins, and open stable identity with no previous selection", () => {
  const catalog = projectCatalogFixture("/fixture");
  catalog.projects.push(
    projectFixture("/fixture", { id: "beta", name: "Beta", pinned: true }),
    projectFixture("/fixture", { id: "old", name: "Old", archived: true }),
  );
  const home = { catalog, summaries: [], asOf: "2026-10-22T00:00:00Z" };
  expect(
    projectCards(home, "active", "").map((item) => item.project.name),
  ).toEqual(["Beta", "Alpha"]);
  expect(
    projectCards(home, "archived", "").map((item) => item.project.name),
  ).toEqual(["Old"]);
  expect(
    projectCards(home, "all", " ALPHA ").map((item) => item.project.name),
  ).toEqual(["Alpha"]);
  expect(openProject("a/b")).toBe("#/desktop/project/a%2Fb/overview");
});

test("first run and unavailable summaries never manufacture cards or usage", () => {
  const view = ProjectsHomeView({
    home: {
      catalog: { version: 1, revision: 0, projects: [] },
      summaries: [],
      asOf: "2026-10-22T00:00:00Z",
    },
    error: null,
    loading: false,
    stale: false,
    held: false,
    writesAllowed: true,
    filter: "active",
    search: "",
    onFilter() {},
    onSearch() {},
    reload() {},
    async change() {},
  });
  expect(
    findAll(view, "EmptyState").map((node) => attrs(node).title),
  ).toContain("Welcome to Agent Forge");
  expect(findAll(view, "article")).toHaveLength(0);
  expect(textOf(view)).not.toContain("42%");
  expect(
    findAll(view, "section").map((node) => attrs(node)["aria-label"]),
  ).toContain("Subscriptions");
});
