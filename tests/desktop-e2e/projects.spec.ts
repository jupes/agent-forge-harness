import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { OPERATOR_HEADER, SURFACE_HEADER } from "../../scripts/hearth/paths";
import { resolveCheckout } from "../../scripts/ledger/workspace";
import { projectFixture } from "../../scripts/projects/testing";
import type { ProjectCatalog } from "../../types/projects";
import { readState, withStateLock, writeState } from "../e2e/bd-stand-in-state";
import { openSettled, reloadSettled } from "../e2e/fixtures";
import { pageToken } from "../e2e/launch-link";
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

test("a protected project reservation stays private until a separate create action", async ({
  page,
}) => {
  const epicId = "onboarding-private-epic";
  const privateSlug = "uncommitted-private-draft";
  const privateName = "Private onboarding draft — must not appear in Projects";
  withStateLock(BD_STAND_IN_STATE, () => {
    const state = readState(BD_STAND_IN_STATE);
    state[epicId] = {
      id: epicId,
      title: "Private onboarding epic",
      issue_type: "epic",
      status: "open",
      priority: 2,
      created_at: "2026-10-27T00:00:00.000Z",
      updated_at: "2026-10-27T00:00:00.000Z",
      labels: [`project:${privateSlug}`],
    };
    writeState(BD_STAND_IN_STATE, state);
  });

  const original = {
    slug: privateSlug,
    name: privateName,
    description: "This reserved original is private until an explicit create.",
    icon: "P",
    workspaces: [
      { root: workspace, repositories: [workspace], epicIds: [epicId] },
    ],
  };
  const postedPaths: string[] = [];
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      request.url().includes("/projects/create-reservations")
    )
      postedPaths.push(new URL(request.url()).pathname);
  });

  await openSettled(page, "/index.html#/desktop/projects");
  const token = await pageToken(page);
  const headers = {
    "Content-Type": "application/json",
    [OPERATOR_HEADER]: token,
    [SURFACE_HEADER]: "ui",
  };
  const before = await page.evaluate(
    async ({ headers }) => {
      const response = await fetch("/__agent-forge/projects", { headers });
      return { status: response.status, body: await response.json() };
    },
    { headers },
  );
  expect(before.status).toBe(200);
  expect(before.body).toMatchObject({
    ok: true,
    data: { revision: 1, projects: [{ slug: "alpha" }, { slug: "beta" }] },
  });
  const catalogBefore = before.body.data as ProjectCatalog;

  const requestId = "ab847e06-4f01-4dd3-a425-47bf9053e006";
  const reserve = await page.evaluate(
    async ({ headers, requestId, original, revision }) => {
      const response = await fetch(
        "/__agent-forge/projects/create-reservations",
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            requestId,
            expectedCatalogRevision: revision,
            original,
          }),
        },
      );
      return { status: response.status, body: await response.json() };
    },
    {
      headers,
      requestId,
      original,
      revision: catalogBefore.revision,
    },
  );
  expect(reserve.status).toBe(201);
  expect(reserve.body).toMatchObject({
    ok: true,
    data: {
      requestId,
      state: "reserved",
      original,
      scopeCount: expect.any(Number),
      requestHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    },
  });
  const requestHash = reserve.body.data.requestHash as string;

  const recovered = await page.evaluate(
    async ({ headers, requestId }) => {
      const response = await fetch(
        `/__agent-forge/projects/create-reservations/${requestId}`,
        { headers },
      );
      return { status: response.status, body: await response.json() };
    },
    { headers, requestId },
  );
  expect(recovered.status).toBe(200);
  expect(recovered.body).toMatchObject({
    ok: true,
    data: { requestId, requestHash, state: "reserved", original },
  });

  const publicCatalog = await page.evaluate(
    async ({ headers }) => {
      const response = await fetch("/__agent-forge/projects", { headers });
      return { status: response.status, body: await response.json() };
    },
    { headers },
  );
  expect(publicCatalog).toEqual({
    status: 200,
    body: { ok: true, data: catalogBefore, error: null },
  });
  expect(JSON.stringify(publicCatalog.body)).not.toContain(privateName);
  expect(JSON.stringify(publicCatalog.body)).not.toContain(privateSlug);

  await expect(
    page.getByRole("button", { name: "New project", exact: true }),
  ).toBeDisabled();
  await reloadSettled(page);
  await expect(
    page.getByRole("article", { name: "Alpha", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("article", { name: "Beta", exact: true }),
  ).toBeVisible();
  await expect(page.getByText(privateName, { exact: true })).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "New project", exact: true }),
  ).toBeDisabled();
  expect(postedPaths).toEqual(["/__agent-forge/projects/create-reservations"]);
  expect(catalogBefore.projects.map(({ id, slug }) => ({ id, slug }))).toEqual([
    { id: alpha.id, slug: alpha.slug },
    { id: beta.id, slug: beta.slug },
  ]);
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

test("project color IDs keep their paired tile styles after reload without a write", async ({
  page,
}) => {
  const projects = [
    alpha,
    projectFixture(workspace, { ...beta, color: "default" }),
    projectFixture(workspace, {
      id: "project-c5832fa0-7a21-403b-8184-44892f0d8d86",
      slug: "green",
      name: "Green",
      color: "green",
    }),
    projectFixture(workspace, {
      id: "project-d5832fa0-7a21-403b-8184-44892f0d8d86",
      slug: "blue",
      name: "Blue",
      color: "blue",
    }),
  ];
  writeFileSync(
    catalogFile,
    JSON.stringify({ version: 1, revision: 4, projects }),
  );
  const posts: string[] = [];
  page.on("request", (request) => {
    if (request.method() !== "POST") return;
    const path = new URL(request.url()).pathname;
    if (path.startsWith("/__agent-forge/projects")) posts.push(path);
  });

  await openSettled(page, "/index.html#/desktop/projects");
  const styles = async () => {
    const result: Record<string, { background: string; foreground: string }> =
      {};
    for (const name of ["Alpha", "Beta", "Green", "Blue"]) {
      const tile = page
        .getByRole("article", { name, exact: true })
        .locator(".af-project-tile");
      await expect(tile).toBeVisible();
      result[name] = await tile.evaluate((element) => {
        const style = getComputedStyle(element);
        return { background: style.backgroundColor, foreground: style.color };
      });
    }
    return result;
  };
  const beforeReload = await styles();
  expect(beforeReload).toEqual({
    Alpha: {
      background: "rgb(53, 57, 78)",
      foreground: "rgb(233, 233, 237)",
    },
    Beta: {
      background: "rgb(53, 57, 78)",
      foreground: "rgb(233, 233, 237)",
    },
    Green: {
      background: "rgb(220, 241, 230)",
      foreground: "rgb(31, 107, 74)",
    },
    Blue: {
      background: "rgb(219, 229, 255)",
      foreground: "rgb(53, 88, 196)",
    },
  });

  await reloadSettled(page);
  expect(await styles()).toEqual(beforeReload);
  expect(posts).toEqual([]);
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
