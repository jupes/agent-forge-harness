import { expect, test } from "@playwright/test";
import { openSettled } from "../e2e/fixtures";
import { alpha, catalog as fixtureCatalog, seedProjects } from "./project-fixtures";

test.beforeEach(seedProjects);

test("project General settings loads the selected fixture fields", async ({
  page,
}) => {
  let postCount = 0;
  let catalogReads = 0;
  await page.route("**/__agent-forge/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "POST") {
      postCount++;
      await route.fulfill({ status: 409, body: "Fixture RED blocks writes." });
      return;
    }
    if (request.method() === "GET" && url.pathname === "/__agent-forge/projects") {
      catalogReads++;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, data: fixtureCatalog, error: null }),
      });
      return;
    }
    await route.continue();
  });

  const summaryResponsePromise = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      response.request().method() === "GET" &&
      url.pathname === "/__agent-forge/projects/summary"
    );
  });
  await openSettled(
    page,
    `/index.html#/desktop/project/${alpha.id}/project-settings`,
  );
  const summaryResponse = await summaryResponsePromise;
  expect(summaryResponse.status()).toBe(200);
  const summaryEnvelope = await summaryResponse.json();
  expect(summaryEnvelope).toMatchObject({
    ok: true,
    data: {
      catalog: {
        projects: expect.arrayContaining([
          expect.objectContaining({ id: alpha.id, name: "Alpha" }),
        ]),
      },
    },
  });

  await expect(
    page.getByRole("heading", { name: "Project settings", exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("Project name", { exact: true })).toHaveValue(
    "Alpha",
  );
  await expect(
    page.getByLabel("Project description", { exact: true }),
  ).toHaveValue("Fixture project");
  await expect(page.getByLabel("Project icon", { exact: true })).toHaveValue(
    "A",
  );
  await page.getByRole("button", { name: "Refresh current settings" }).click();
  await expect(page.locator(".af-project-settings-provenance")).toContainText(
    "current hearth project catalog read",
  );
  expect(catalogReads).toBe(1);
  expect(postCount).toBe(0);
});

test("General settings posts one revision-bound complete snapshot and reads it back", async ({
  page,
}) => {
  let current = {
    ...fixtureCatalog,
    projects: fixtureCatalog.projects.map((project) => ({ ...project })),
  };
  let postCount = 0;
  const body = {
    name: "Alpha renamed",
    description: "Changed in project settings",
    icon: "A",
    color: "green" as const,
  };
  const nextCatalog = () => ({
    ...current,
    revision: current.revision + 1,
    projects: current.projects.map((project) =>
      project.id === alpha.id
        ? { ...project, ...body, updatedAt: "2026-10-31T00:00:00.000Z" }
        : project,
    ),
  });
  await page.route("**/__agent-forge/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "POST") {
      postCount++;
      expect(url.pathname).toBe(
        `/__agent-forge/projects/${alpha.id}/settings/general`,
      );
      expect(request.postDataJSON()).toEqual({
        expectedRevision: 1,
        general: body,
      });
      current = nextCatalog();
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, data: current, error: null }),
      });
      return;
    }
    if (request.method() === "GET" && url.pathname === "/__agent-forge/projects") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, data: current, error: null }),
      });
      return;
    }
    await route.continue();
  });

  const summary = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === "/__agent-forge/projects/summary";
  });
  await openSettled(
    page,
    `/index.html#/desktop/project/${alpha.id}/project-settings`,
  );
  expect((await summary).status()).toBe(200);
  await expect(page.getByLabel("Project name", { exact: true })).toHaveValue("Alpha");
  await page.getByLabel("Project name", { exact: true }).fill(body.name);
  await page
    .getByLabel("Project description", { exact: true })
    .fill(body.description);
  await page.getByLabel("Project color", { exact: true }).selectOption(body.color);
  await page.getByRole("button", { name: "Save General settings" }).click();

  const general = page.getByRole("region", { name: "General" });
  await expect(page.getByLabel("Project name", { exact: true })).toHaveValue(
    body.name,
  );
  await expect(general.getByRole("status")).toContainText(
    "Current project settings read at catalog revision 2",
  );
  expect(postCount).toBe(1);
});

test("unknown General save stays held until same-project review creates a new intent", async ({
  page,
}) => {
  let current = {
    ...fixtureCatalog,
    projects: fixtureCatalog.projects.map((project) => ({ ...project })),
  };
  let postCount = 0;
  const name = "Maybe changed";
  await page.route("**/__agent-forge/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "POST") {
      postCount++;
      expect(url.pathname).toBe(
        `/__agent-forge/projects/${alpha.id}/settings/general`,
      );
      if (postCount === 1) {
        await route.fulfill({ status: 503, body: "Unavailable" });
        return;
      }
      expect(request.postDataJSON()).toMatchObject({
        expectedRevision: 1,
        general: { name },
      });
      current = {
        ...current,
        revision: 2,
        projects: current.projects.map((project) =>
          project.id === alpha.id
            ? { ...project, name, updatedAt: "2026-10-31T00:00:00.000Z" }
            : project,
        ),
      };
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, data: current, error: null }),
      });
      return;
    }
    if (request.method() === "GET" && url.pathname === "/__agent-forge/projects") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, data: current, error: null }),
      });
      return;
    }
    await route.continue();
  });

  const summary = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === "/__agent-forge/projects/summary";
  });
  await openSettled(
    page,
    `/index.html#/desktop/project/${alpha.id}/project-settings`,
  );
  expect((await summary).status()).toBe(200);
  await expect(page.getByLabel("Project name", { exact: true })).toHaveValue("Alpha");
  await page.getByLabel("Project name", { exact: true }).fill(name);
  await page.getByRole("button", { name: "Save General settings" }).click();
  const general = page.getByRole("region", { name: "General" });
  await expect(general.getByRole("status")).toContainText("outcome is unknown");
  expect(postCount).toBe(1);

  await page.getByRole("button", { name: "Check current settings" }).click();
  await expect(general.getByRole("status")).toContainText("earlier outcome remains unknown");
  expect(postCount).toBe(1);
  await page.getByRole("button", { name: "I reviewed the current values" }).click();
  await page.getByRole("button", { name: "Save General settings" }).click();
  await expect(general.getByRole("status").filter({ hasText: "Current project settings read" })).toContainText(
    "Current project settings read at catalog revision 2",
  );
  await expect(general.getByRole("status").filter({ hasText: "outcome remains unknown" })).toBeVisible();
  expect(postCount).toBe(2);
});
