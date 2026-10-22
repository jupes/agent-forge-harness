import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { resolveCheckout } from "../../scripts/ledger/workspace";
import { projectFixture } from "../../scripts/projects/testing";
import type { ProjectCatalog } from "../../types/projects";
import { readState, withStateLock, writeState } from "../e2e/bd-stand-in-state";
import { BD_STAND_IN_STATE, HEARTH_HOME } from "../e2e/servers";

const catalogFile = join(HEARTH_HOME, "projects", "catalog.json");
const workspace = resolveCheckout(process.cwd()).workspace;
const alpha = projectFixture(workspace);
const beta = projectFixture(workspace, {
  id: "project-b5832fa0-7a21-403b-8184-44892f0d8d86",
  slug: "beta",
  name: "Beta",
  workspaces: [
    { root: workspace, repositories: [workspace], epicIds: ["beta-epic"] },
  ],
});
const catalog: ProjectCatalog = {
  version: 1,
  revision: 1,
  projects: [alpha, beta],
};

test.beforeEach(() => {
  mkdirSync(join(HEARTH_HOME, "projects"), { recursive: true });
  writeFileSync(catalogFile, JSON.stringify(catalog));
  withStateLock(BD_STAND_IN_STATE, () =>
    writeState(
      BD_STAND_IN_STATE,
      Object.fromEntries(
        [alpha, beta].map((project) => [
          `${project.slug}-epic`,
          {
            id: `${project.slug}-epic`,
            title: `${project.name} epic`,
            issue_type: "epic",
            status: "open",
            priority: 2,
            created_at: project.createdAt,
            updated_at: project.updatedAt,
            labels: [`project:${project.slug}`],
          },
        ]),
      ),
    ),
  );
});

test("projects persist pin/archive through the real hearth, filter and switch without stale selection", async ({
  page,
}) => {
  await page.goto("/index.html#/desktop/projects");
  await expect(
    page.getByRole("button", { name: "Pin Alpha", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Pin Alpha", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Unpin Alpha", exact: true }),
  ).toBeEnabled();
  await page.setViewportSize({ width: 1600, height: 1100 });
  await page.screenshot({ path: test.info().outputPath("projects-home.png") });
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Unpin Alpha", exact: true }),
  ).toBeEnabled();
  await page
    .getByRole("button", { name: "Archive Alpha", exact: true })
    .click();
  await expect(
    page.getByRole("article", { name: "Alpha", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("combobox", { name: "Show", exact: true }),
  ).toBeFocused();
  await page
    .getByRole("combobox", { name: "Show", exact: true })
    .selectOption("archived");
  await expect(
    page.getByRole("article", { name: "Alpha", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("combobox", { name: "Show", exact: true })
    .selectOption("all");
  await page.getByRole("link", { name: "Open Alpha", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/project/${alpha.id}/overview$`));
  await page.goto(
    `/index.html#/desktop/projects?project=${alpha.id}&selectionKind=bead&selectionId=old-selection`,
  );
  await page.getByRole("link", { name: "Open Beta", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/project/${beta.id}/overview$`));
  await expect(page.locator(".af-desktop-project-name")).toHaveText("Beta");
  let persisted: ProjectCatalog;
  try {
    persisted = JSON.parse(readFileSync(catalogFile, "utf8"));
  } catch {
    throw new Error("Fixture catalog is not readable JSON");
  }
  expect(persisted.projects[0]).toMatchObject({ pinned: true, archived: true });
});

test("an unanswered preference is held across navigation until an explicit check", async ({
  page,
}) => {
  let posts = 0;
  await page.route("**/projects/*/preferences", async (route) => {
    posts++;
    await route.abort("failed");
  });
  await page.goto("/index.html#/desktop/projects");
  await page.getByRole("button", { name: "Pin Alpha", exact: true }).click();
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: "The preference may have changed" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Pin Alpha", exact: true }),
  ).toBeDisabled();
  await page.getByRole("link", { name: "Open Beta", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Check project preferences" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Check project preferences" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "checked against the hearth" }),
  ).toBeVisible();
  expect(posts).toBe(1);
});

test("first-run, corrupt store and filtered-empty states stay distinct", async ({
  page,
}) => {
  writeFileSync(catalogFile, "{");
  await page.goto("/index.html#/desktop/projects");
  await expect(
    page.getByText("Projects could not be loaded", { exact: true }),
  ).toBeVisible();
  writeFileSync(
    catalogFile,
    JSON.stringify({ version: 1, revision: 0, projects: [] }),
  );
  await page.getByRole("button", { name: "Refresh projects" }).click();
  await expect(
    page.getByText("Welcome to Agent Forge", { exact: true }),
  ).toBeVisible();
  writeFileSync(catalogFile, JSON.stringify(catalog));
  await page.getByRole("button", { name: "Refresh projects" }).click();
  await page.getByLabel("Find projects").fill("No match");
  await expect(
    page.getByText("No matching projects", { exact: true }),
  ).toBeVisible();
  await page.getByLabel("Find projects").fill("");
  await page.setViewportSize({ width: 1100, height: 700 });
  await page.getByRole("link", { name: "Open Alpha", exact: true }).focus();
  expect(
    await page
      .getByRole("link", { name: "Open Alpha", exact: true })
      .evaluate((element) => getComputedStyle(element).outlineStyle),
  ).not.toBe("none");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(new RegExp(`/project/${alpha.id}/overview$`));
});

test("a pending post cannot be unlocked by checking early or double clicking", async ({
  page,
}) => {
  let posts = 0;
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/projects/*/preferences", async (route) => {
    posts++;
    await held;
    await route.continue();
  });
  await page.goto("/index.html#/desktop/projects");
  const pin = page.getByRole("button", { name: "Pin Alpha", exact: true });
  await expect(pin).toBeEnabled();
  await pin.evaluate((element) => {
    if (!(element instanceof HTMLButtonElement))
      throw new Error("Expected a button");
    element.click();
    element.click();
  });
  await expect(
    page.getByText("Saving project preferences…", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Check project preferences" }),
  ).toHaveCount(0);
  await expect(pin).toBeDisabled();
  release();
  await expect(
    page.getByRole("button", { name: "Unpin Alpha", exact: true }),
  ).toBeEnabled();
  expect(posts).toBe(1);
});

test("scoped queue counts do not leak and a failed refresh retains labelled last-known cards", async ({
  page,
}) => {
  withStateLock(BD_STAND_IN_STATE, () => {
    const state = readState(BD_STAND_IN_STATE);
    const item = state["alpha-epic"];
    if (!item) throw new Error("Missing fixture epic");
    state["alpha-epic"] = {
      ...item,
      labels: [...(item.labels ?? []), "queue:proposed"],
      metadata: { queue_state: "proposed" },
    };
    writeState(BD_STAND_IN_STATE, state);
  });
  await page.goto("/index.html#/desktop/projects");
  const a = page.getByRole("article", { name: "Alpha", exact: true });
  const b = page.getByRole("article", { name: "Beta", exact: true });
  await expect(a.locator('[data-state="proposed"]')).toHaveText("Proposed 1");
  await expect(b.locator('[data-state="proposed"]')).toHaveText("Proposed 0");
  await page.route("**/projects/summary", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({
        ok: false,
        data: null,
        error: "Fixture hearth unavailable",
      }),
    }),
  );
  await page.getByRole("button", { name: "Refresh projects" }).click();
  await expect(
    page.getByText(/Refresh failed: Fixture hearth unavailable/),
  ).toBeVisible();
  await expect(a.locator('[data-state="proposed"]')).toHaveText("Proposed 1");
  await expect(page.locator(".af-projects-home")).toHaveAttribute(
    "data-last-known",
    "true",
  );
});
