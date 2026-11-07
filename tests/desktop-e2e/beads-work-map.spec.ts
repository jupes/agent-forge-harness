import { mkdirSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { projectBeadSchema } from "../../scripts/projects/beads-protocol";
import type { ProjectBead, ProjectBeadsPage } from "../../types/project-beads";
import { openSettled } from "../e2e/fixtures";
import { alpha, seedProjects, workspace } from "./project-fixtures";

const bead = (id: string, extra: Partial<ProjectBead> = {}) =>
  projectBeadSchema.parse({
    id,
    title: id,
    type: "task",
    status: "open",
    priority: 2,
    parent: "alpha-epic",
    assignee: null,
    owner: null,
    labels: ["project:alpha"],
    createdAt: alpha.createdAt,
    updatedAt: alpha.updatedAt,
    due: null,
    description: "Controlled work-map bead details",
    acceptanceCriteria: "",
    estimate: null,
    spent: null,
    ready: true,
    blocked: false,
    blockers: [],
    unavailableBlockers: 0,
    queue: null,
    smith: null,
    comments: [],
    commentsComplete: true,
    detailsLoaded: false,
    ...extra,
  });
const sample = (): ProjectBeadsPage => ({
  projectId: alpha.id,
  workspace,
  asOf: "2026-11-07T07:00:00.000Z",
  complete: true,
  problems: [],
  beads: [
    bead("alpha-epic", {
      title: "Root initiative",
      type: "epic",
      parent: null,
    }),
    bead("map-feature", { title: "Ship the work map", type: "feature" }),
    bead("map-design", {
      title: "Design the map",
      parent: "map-feature",
      status: "closed",
      ready: false,
    }),
    bead("map-build", {
      title: "Build the map",
      parent: "map-feature",
      status: "in_progress",
      ready: false,
      blocked: false,
      blockers: [],
      queue: "running",
    }),
    bead("map-review", {
      title: "Review the map",
      parent: "map-feature",
      ready: false,
      blocked: true,
      blockers: ["map-build"],
      unavailableBlockers: 1,
    }),
    bead("map-cycle-a", { title: "Cycle A", blocked: true, ready: false }),
    bead("map-cycle-b", { title: "Cycle B", blocked: true, ready: false }),
  ],
  dependencies: [
    { from: "map-build", to: "map-design", type: "blocks" },
    { from: "map-review", to: "map-build", type: "requires" },
    { from: "map-cycle-a", to: "map-cycle-b", type: "blocks" },
    { from: "map-cycle-b", to: "map-cycle-a", type: "requires" },
    { from: "map-cycle-a", to: "map-feature", type: "relates" },
  ],
});

test("work map expands real hierarchy, navigates dependencies and retains the diagram through detail reads", async ({
  page,
}) => {
  seedProjects();
  await page.setViewportSize({ width: 1600, height: 1050 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  const source = sample();
  let fail = false,
    hold = false,
    release = () => {},
    observed = () => {};
  const pending = new Promise<void>((resolve) => {
      release = resolve;
    }),
    started = new Promise<void>((resolve) => {
      observed = resolve;
    });
  await page.route(
    `**/__agent-forge/projects/${alpha.id}/beads**`,
    async (route) => {
      expect(route.request().method()).toBe("GET");
      const selected = new URL(route.request().url()).searchParams.get(
        "beadId",
      );
      if (hold && selected === "map-design") {
        observed();
        await pending;
      }
      if (fail) {
        await route.fulfill({
          status: 503,
          json: {
            ok: false,
            data: null,
            error: "Controlled tracker unavailable",
          },
        });
        return;
      }
      await route.fulfill({
        status: 200,
        json: {
          ok: true,
          data: {
            ...source,
            beads: source.beads.map((row) => ({
              ...row,
              detailsLoaded: row.id === selected,
            })),
          },
          error: null,
        },
      });
    },
  );
  try {
    await openSettled(page, `/index.html#/desktop/project/${alpha.id}/beads`);
    const region = page.getByRole("region", {
      name: "Project beads",
      exact: true,
    });
    await region.getByRole("tab", { name: /^All/ }).click();
    await region.getByRole("button", { name: "Tree", exact: true }).click();
    const map = region.getByRole("region", {
        name: "Beads work map",
        exact: true,
      }),
      tree = map.getByRole("tree", { name: "Bead hierarchy" });
    const feature = tree.getByRole("treeitem", { name: /Ship the work map/ });
    await expect(feature).toBeVisible();
    await expect(map).toContainText("1/3 descendants closed");
    await feature.focus();
    await page.keyboard.press("ArrowLeft");
    await expect(feature).toHaveAttribute("aria-expanded", "false");
    await expect(
      tree.getByRole("treeitem", { name: /Build the map/ }),
    ).toHaveCount(0);
    await page.keyboard.press("ArrowRight");
    await expect(feature).toHaveAttribute("aria-expanded", "true");
    await page.keyboard.press("ArrowRight");
    await expect(
      tree.getByRole("treeitem", { name: /Build the map/ }),
    ).toBeFocused();
    mkdirSync("test-results/work-map-evidence", { recursive: true });
    await page.screenshot({ path: "test-results/work-map-evidence/tree.png" });
    await region
      .getByRole("button", { name: "Dependency graph", exact: true })
      .click();
    await expect(map).toContainText("Dependency cycle: 2 beads");
    await expect(map).toContainText("1 open prerequisite reference");
    await expect(map).toContainText("Prerequisite to dependent work");
    await map
      .getByRole("button", { name: "Zoom graph out", exact: true })
      .click();
    await expect(map.getByLabel("Graph zoom")).toHaveText("80%");
    hold = true;
    await map
      .getByRole("button", {
        name: "Inspect map-design: Design the map",
        exact: true,
      })
      .click();
    await started;
    await expect(map.getByLabel("Graph zoom")).toHaveText("80%");
    await expect(map).toContainText("previous tracker read remains visible");
    release();
    await expect(
      page.getByRole("region", { name: "Bead map-design", exact: true }),
    ).toContainText("Controlled work-map bead details");
    await expect(map.getByLabel("Graph zoom")).toHaveText("80%");
    await map.getByRole("button", { name: "Fit diagram", exact: true }).click();
    await map.screenshot({
      path: "test-results/work-map-evidence/dependencies.png",
    });
    await region
      .getByRole("searchbox", { name: "Search beads by id or title" })
      .fill("map-review");
    await expect(
      map.getByRole("button", { name: /^Inspect map-build:/ }),
    ).toBeVisible();
    await map.locator(".af-workmap-equivalent > summary").click();
    const outline = map.getByRole("tree", { name: "Bead hierarchy" });
    await expect(
      outline.getByRole("treeitem", { name: /Build the map/ }),
    ).toBeVisible();
    await region
      .getByRole("searchbox", { name: "Search beads by id or title" })
      .fill("");
    fail = true;
    await region
      .getByRole("button", { name: "Refresh beads", exact: true })
      .click();
    await expect(map).toContainText(
      "Showing the retained tracker read; refresh failed",
    );
    await expect(
      map.getByRole("button", { name: /^Inspect map-review:/ }),
    ).toBeVisible();
  } finally {
    release();
  }
});

test("large partial work maps retain the complete keyboard outline and make diagram limits explicit", async ({
  page,
}) => {
  seedProjects();
  await page.setViewportSize({ width: 1100, height: 700 });
  const source = sample();
  source.complete = false;
  source.problems = ["Other workspace data is unavailable."];
  source.beads = [
    source.beads[0]!,
    ...Array.from({ length: 301 }, (_, index) =>
      bead(`large-${index}`, { title: `Large task ${index}` }),
    ),
  ];
  source.dependencies = [];
  await page.route(`**/__agent-forge/projects/${alpha.id}/beads**`, (route) =>
    route.fulfill({
      status: 200,
      json: { ok: true, data: source, error: null },
    }),
  );
  await openSettled(page, `/index.html#/desktop/project/${alpha.id}/beads`);
  const region = page.getByRole("region", {
    name: "Project beads",
    exact: true,
  });
  await region.getByRole("tab", { name: /^All/ }).click();
  await region
    .getByRole("button", { name: "Dependency graph", exact: true })
    .click();
  const map = region.getByRole("region", {
    name: "Beads work map",
    exact: true,
  });
  await expect(map).toContainText("Diagram paused at 302 beads / 0 links");
  await expect(map).toContainText("Partial project read");
  const tree = map.getByRole("tree", { name: "Bead hierarchy" });
  await expect(tree.getByRole("treeitem")).toHaveCount(302);
  await tree.getByRole("treeitem").first().focus();
  await page.keyboard.press("End");
  await expect(tree.getByRole("treeitem").last()).toBeFocused();
  await page.keyboard.press("Home");
  await expect(tree.getByRole("treeitem").first()).toBeFocused();
  mkdirSync("test-results/work-map-evidence", { recursive: true });
  await page.screenshot({
    path: "test-results/work-map-evidence/narrow-outline.png",
  });
});
