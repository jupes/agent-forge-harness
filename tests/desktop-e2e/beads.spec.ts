import { expect, test } from "@playwright/test";
import { readState, withStateLock, writeState } from "../e2e/bd-stand-in-state";
import { openSettled } from "../e2e/fixtures";
import { BD_STAND_IN_STATE } from "../e2e/servers";
import { alpha, beta, seedProjects } from "./project-fixtures";

test.beforeEach(() => {
  seedProjects();
  withStateLock(BD_STAND_IN_STATE, () => {
    const state = readState(BD_STAND_IN_STATE);
    const bead = (id: string, extra: Record<string, unknown> = {}) => ({
      id,
      title: `Title ${id}`,
      issue_type: "task",
      status: "open",
      priority: 2,
      labels: ["project:alpha"],
      created_at: alpha.createdAt,
      updated_at: alpha.updatedAt,
      dependencies: [
        { issue_id: id, depends_on_id: "alpha-epic", type: "parent-child" },
      ],
      ...extra,
    });
    Object.assign(state, {
      "alpha-ready": bead("alpha-ready", { priority: 4, owner: "creator" }),
      "alpha-claimed": bead("alpha-claimed", { assignee: "worker" }),
      "alpha-active": bead("alpha-active", {
        status: "in_progress",
        priority: 0,
      }),
      "alpha-closed": bead("alpha-closed", { status: "closed" }),
      "alpha-deferred": bead("alpha-deferred", {
        status: "deferred",
        priority: 4,
      }),
      "alpha-blocked": bead("alpha-blocked", {
        description: "Exact description\n\n## Files\nscripts/example.ts",
        acceptance_criteria: "- [ ] Verify the dependency",
        comment_count: 1,
        comments: [
          {
            text: "worklog: tested isolated fixture",
            author: "worker",
            created_at: alpha.createdAt,
          },
        ],
        dependencies: [
          {
            issue_id: "alpha-blocked",
            depends_on_id: "alpha-epic",
            type: "parent-child",
          },
          {
            issue_id: "alpha-blocked",
            depends_on_id: "alpha-active",
            type: "blocks",
          },
        ],
      }),
      "beta-secret": bead("beta-secret", {
        title: "Foreign Beta Secret",
        labels: ["project:beta"],
        dependencies: [
          {
            issue_id: "beta-secret",
            depends_on_id: "beta-epic",
            type: "parent-child",
          },
        ],
      }),
    });
    writeState(BD_STAND_IN_STATE, state);
  });
});
test("Ready preserves P4 and claim semantics, combined filters and dependency inspector navigate stable bead routes", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1600, height: 1100 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openSettled(page, `/index.html#/desktop/project/${alpha.id}/beads`);
  const region = page.getByRole("region", { name: "Project beads" });
  await expect(
    region.getByRole("button", {
      name: "Inspect alpha-ready: Title alpha-ready",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    region.getByRole("button", {
      name: /Inspect alpha-(claimed|deferred|blocked)/,
    }),
  ).toHaveCount(0);
  await expect(region).not.toContainText("Foreign Beta Secret");
  await region
    .getByRole("combobox", { name: "Filter beads by priority", exact: true })
    .selectOption("4");
  await expect(region.getByRole("table")).toContainText("P4");
  await expect(
    region.getByRole("button", {
      name: "Inspect alpha-epic: Alpha epic",
      exact: true,
    }),
  ).toHaveCount(0);
  await region.getByRole("button", { name: "Reset views and filters" }).click();
  await page.screenshot({
    path: "apps/desktop/docs/screenshots/beads-ready.png",
  });
  await region.getByRole("tab", { name: /^All/ }).click();
  const inspect = region.getByRole("button", {
    name: "Inspect alpha-blocked: Title alpha-blocked",
    exact: true,
  });
  await inspect.click();
  const panel = page.getByRole("region", {
    name: "Bead alpha-blocked",
    exact: true,
  });
  await expect(panel).toContainText("Exact description");
  await panel.getByRole("tab", { name: "Dependencies", exact: true }).click();
  await expect(
    panel.getByRole("group", { name: "Dependency graph for alpha-blocked" }),
  ).toContainText("alpha-active");
  await expect(panel.getByRole("tabpanel")).toContainText("Blocked by");
  await inspect.focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/selectionId=alpha-blocked&view=full$/);
  await expect(
    page.getByRole("link", { name: "Back to Beads", exact: true }),
  ).toBeVisible();
  const full = page.getByRole("main").getByRole("region", {
    name: "Bead alpha-blocked",
    exact: true,
  });
  await full.getByRole("tab", { name: "Comments", exact: true }).click();
  await expect(full.getByRole("tabpanel")).toContainText(
    "worklog: tested isolated fixture",
  );
  await full.getByRole("tab", { name: "Files", exact: true }).click();
  await expect(full.getByRole("tabpanel")).toContainText("scripts/example.ts");
  await expect(full.getByRole("tabpanel")).toContainText(
    "No active bead-bound reservations",
  );
  await full.getByRole("tab", { name: "Activity", exact: true }).click();
  await expect(full.getByRole("tabpanel")).toContainText(
    "Hearth-recorded bead activity",
  );
  await full.getByRole("tab", { name: "Details", exact: true }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(
    full.getByRole("tab", { name: "Dependencies", exact: true }),
  ).toBeFocused();
  await page.screenshot({
    path: "apps/desktop/docs/screenshots/beads-detail.png",
  });
  await page.getByRole("link", { name: "Back to Beads", exact: true }).click();
  await page.getByRole("tab", { name: /^Epics/ }).click();
  await expect(
    page.getByRole("progressbar", {
      name: "Progress for alpha-epic",
      exact: true,
    }),
  ).toBeVisible();
  await page.screenshot({
    path: "apps/desktop/docs/screenshots/beads-epics.png",
  });
});
test("bead loading, failed reads, filtered empty and project switching stay explicit", async ({
  page,
}) => {
  await page.route(`**/__agent-forge/projects/${alpha.id}/beads`, (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({
        ok: false,
        data: null,
        error: "Fixture tracker unavailable. Refresh to check again.",
      }),
    }),
  );
  await openSettled(page, `/index.html#/desktop/project/${alpha.id}/beads`);
  await expect(
    page.getByRole("alert").filter({ hasText: "Fixture tracker unavailable" }),
  ).toBeVisible();
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await page
    .getByRole("button", { name: "Refresh beads", exact: true })
    .click();
  await expect(
    page.getByRole("button", {
      name: "Inspect alpha-ready: Title alpha-ready",
      exact: true,
    }),
  ).toBeVisible();
  const search = page.getByRole("searchbox", {
    name: "Search beads by id or title",
  });
  await search.fill("no-matching-bead");
  await expect(
    page.getByText("No beads match these filters", { exact: true }),
  ).toBeVisible();
  await page.goto(`/index.html#/desktop/project/${beta.id}/beads`);
  await expect(
    page.getByRole("button", {
      name: "Inspect beta-secret: Foreign Beta Secret",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Project beads" }),
  ).not.toContainText("alpha-ready");
  await expect(
    page.getByRole("searchbox", { name: "Search beads by id or title" }),
  ).toHaveValue("");
});
test("full-width bead errors retain provenance and expose retry on first-load failure", async ({
  page,
}) => {
  await openSettled(
    page,
    `/index.html#/desktop/project/${alpha.id}/beads?selectionKind=bead&selectionId=alpha-blocked&view=full`,
  );
  const panel = page
    .getByRole("main")
    .getByRole("region", { name: "Bead alpha-blocked", exact: true });
  await expect(panel).toContainText("Exact description");
  await page.route(
    `**/__agent-forge/projects/${alpha.id}/beads?beadId=alpha-blocked`,
    (route) =>
      route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          ok: false,
          data: null,
          error: "Fixture selected read unavailable.",
        }),
      }),
  );
  await panel
    .getByRole("button", { name: "Refresh selected bead", exact: true })
    .click();
  await expect(panel.getByRole("alert")).toContainText(
    "Showing the last confirmed read",
  );
  await expect(panel).toContainText("Exact description");
  await expect(
    panel.getByRole("button", { name: "Start session", exact: true }),
  ).toBeDisabled();
  await page.reload();
  await expect(panel.getByRole("alert")).toContainText(
    "Fixture selected read unavailable",
  );
  await expect(
    panel.getByRole("button", { name: "Retry bead read", exact: true }),
  ).toBeEnabled();
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await panel
    .getByRole("button", { name: "Retry bead read", exact: true })
    .click();
  await expect(panel).toContainText("Exact description");
});
test("a successful bead read does not present incomplete session observations as a confirmed empty history", async ({
  page,
}) => {
  await page.route("**/__agent-forge/projects/summary", async (route) => {
    const response = await route.fetch({
      headers: {
        ...(await route.request().allHeaders()),
        Origin: new URL(route.request().url()).origin,
        "Sec-Fetch-Site": "same-origin",
      },
    });
    const body = await response.json();
    if (!body.ok || !Array.isArray(body.data?.summaries))
      throw Error("Invalid summary fixture");
    for (const summary of body.data.summaries) {
      summary.sessions = [];
      summary.sessionsComplete = false;
    }
    await route.fulfill({ response, json: body });
  });
  await openSettled(
    page,
    `/index.html#/desktop/project/${alpha.id}/beads?selectionKind=bead&selectionId=alpha-blocked&view=full`,
  );
  const panel = page
    .getByRole("main")
    .getByRole("region", { name: "Bead alpha-blocked", exact: true });
  await expect(panel).toContainText("Exact description");
  await panel.getByRole("tab", { name: "Sessions", exact: true }).click();
  await expect(panel.getByRole("tabpanel")).toContainText(
    "Session observations are incomplete or unavailable",
  );
});
