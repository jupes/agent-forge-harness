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
    projectCreate: {
      phase: "ready",
      options: null,
      smiths: null,
      catalogRevision: null,
      entries: [],
      busy: false,
      error: "",
      notice: "",
    },
    projectCreateOwner: {} as never,
    canCreateProject: true,
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

test("project cards offer enabled session preparation for the exact selected project", () => {
  const project = projectFixture("/fixture", { id: "beta", name: "Beta" });
  const prepared: string[] = [];
  const view = ProjectsHomeView({
    home: {
      catalog: { version: 1, revision: 1, projects: [project] },
      summaries: [],
      asOf: "2026-11-16T00:00:00Z",
    },
    error: null,
    loading: false,
    stale: false,
    held: false,
    writesAllowed: true,
    projectCreate: {
      phase: "ready",
      options: null,
      smiths: null,
      catalogRevision: 1,
      entries: [],
      busy: false,
      error: "",
      notice: "",
    },
    projectCreateOwner: {} as never,
    canCreateProject: true,
    filter: "active",
    search: "",
    onFilter() {},
    onSearch() {},
    reload() {},
    async change() {},
    onNewSession(id) {
      prepared.push(id);
    },
  });
  const button = findAll(view, "Button").find(
    (node) => textOf(node) === "New session",
  );
  if (!button) throw Error("Missing project session action");
  expect(Boolean(attrs(button).disabled)).toBe(false);
  const click = attrs(button).onClick;
  if (typeof click !== "function") throw Error("Missing preparation callback");
  click();
  expect(prepared).toEqual([project.id]);
});
