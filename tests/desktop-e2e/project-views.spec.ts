import { expect, test } from "@playwright/test";
import { readState, withStateLock, writeState } from "../e2e/bd-stand-in-state";
import { BD_STAND_IN_STATE } from "../e2e/servers";
import { alpha, beta, seedProjects, seedSessions } from "./project-fixtures";

test.beforeEach(seedProjects);

test("Overview shows three of four scoped needs-you items and linked sections", async ({
  page,
}) => {
  withStateLock(BD_STAND_IN_STATE, () => {
    const state = readState(BD_STAND_IN_STATE);
    for (const [index, queue] of [
      "proposed",
      "review",
      "halted",
      "proposed",
    ].entries()) {
      const id = `alpha-child-${index}`;
      const row = {
        id,
        title: `Scoped task ${index}`,
        issue_type: "task",
        status: "open",
        priority: 2,
        created_at: alpha.createdAt,
        updated_at: alpha.updatedAt,
        labels: ["project:alpha", `queue:${queue}`],
        metadata: { queue_state: queue },
        dependencies: [
          { issue_id: id, depends_on_id: "alpha-epic", type: "parent-child" },
        ],
      };
      state[id] = row;
    }
    writeState(BD_STAND_IN_STATE, state);
  });
  await page.goto(`/index.html#/desktop/project/${alpha.id}/overview`);
  const needs = page.getByRole("region", { name: "Needs you", exact: true });
  await expect(
    needs.getByRole("heading", { name: "Needs you · 4" }),
  ).toBeVisible();
  await expect(needs.getByRole("listitem")).toHaveCount(3);
  await expect(
    needs.getByRole("link", { name: "See all 4 queue items" }),
  ).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Reported project usage" }),
  ).toContainText("no project session totals were reported in this read");
  await expect(
    page.getByRole("region", { name: "Scoped bead counts" }),
  ).toContainText("5Open");
  await expect(
    page.getByRole("region", { name: "Epics", exact: true }),
  ).toContainText("Alpha epic");
  await page.screenshot({
    path: test.info().outputPath("project-overview.png"),
  });
  await needs.getByRole("link", { name: /alpha-child-0/ }).click();
  await expect(page).toHaveURL(
    /workbench\?selectionKind=bead&selectionId=alpha-child-0$/,
  );
});

test("a delayed previous-project read cannot paint the next project, and Back restores scope", async ({
  page,
}) => {
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let first = true;
  await page.route(`**/projects/${alpha.id}/overview`, async (route) => {
    if (first) {
      first = false;
      await held;
    }
    await route.continue();
  });
  await page.goto(`/index.html#/desktop/project/${alpha.id}/overview`);
  await expect(
    page.getByText("Loading project overview…", { exact: true }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Projects", exact: true }).click();
  await page.getByRole("link", { name: "Open Beta", exact: true }).click();
  await expect(
    page.getByRole("region", { name: "Epics", exact: true }),
  ).toContainText("Beta epic");
  const oldRead = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/projects/${alpha.id}/overview`) &&
      response.status() === 200,
  );
  release();
  await oldRead;
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
  );
  await expect(
    page.getByRole("region", { name: "Epics", exact: true }),
  ).not.toContainText("Alpha epic");
  await expect(page.locator(".af-desktop-project-name")).toHaveText("Beta");
  await page.goBack();
  await page.goBack();
  await expect(
    page.getByRole("region", { name: "Epics", exact: true }),
  ).toContainText("Alpha epic");
  await expect(page.locator(".af-desktop-project-name")).toHaveText("Alpha");
});

test("session list and sidebar share scope, filtering and inspector; switching rejects foreign selection", async ({
  page,
}) => {
  seedSessions();
  await page.goto(`/index.html#/desktop/project/${alpha.id}/sessions`);
  const observed = page.getByRole("region", { name: "Observed", exact: true });
  await expect(observed.getByRole("row")).toHaveCount(3);
  await expect(observed).toContainText("e2e-alpha-parent");
  await expect(observed).toContainText("e2e-alpha-child");
  await expect(observed).not.toContainText("e2e-beta-own");
  const indent = await page
    .locator('.af-desktop-sidebar a[href*="selectionId=e2e-alpha-child"]')
    .evaluate((element) =>
      Number.parseFloat(getComputedStyle(element).paddingLeft),
    );
  const parentIndent = await page
    .locator('.af-desktop-sidebar a[href*="selectionId=e2e-alpha-parent"]')
    .evaluate((element) =>
      Number.parseFloat(getComputedStyle(element).paddingLeft),
    );
  expect(indent).toBeGreaterThan(parentIndent);
  await page
    .getByRole("link", { name: "Open e2e-alpha-child", exact: true })
    .click();
  await expect(
    page.getByRole("region", { name: "Selected session" }),
  ).toContainText("e2e-alpha-child");
  await page.screenshot({
    path: test.info().outputPath("project-sessions.png"),
  });
  await page.getByLabel("Find sessions").fill("no match");
  await expect(
    page.getByText("No matching sessions", { exact: true }),
  ).toBeVisible();
  await page.getByLabel("Find sessions").fill("");
  await page.getByLabel("Select e2e-alpha-child", { exact: true }).check();
  await expect(
    page.getByRole("button", { name: "Stop selected", exact: true }),
  ).toBeDisabled();
  await page.goto(
    `/index.html#/desktop/project/${beta.id}/sessions?selectionKind=session&selectionId=e2e-alpha-child`,
  );
  await expect(
    page.getByText("Session unavailable in this project", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Observed", exact: true }),
  ).toContainText("e2e-beta-own");
  await expect(
    page.getByRole("region", { name: "Observed", exact: true }),
  ).not.toContainText("e2e-alpha-child");
  await page.setViewportSize({ width: 1100, height: 700 });
  const keeper = page.getByRole("link", { name: "Forge Keeper", exact: true });
  await keeper.focus();
  await expect(keeper).toBeFocused();
  await page.screenshot({
    path: test.info().outputPath("project-sessions-1100.png"),
  });
});
