import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { ProjectRepositoriesData } from "../../scripts/projects/project-repositories-protocol";
import { openSettled } from "../e2e/fixtures";
import {
  alpha,
  beta,
  catalog as fixtureCatalog,
  seedProjects,
  workspace,
} from "./project-fixtures";

function repositoryFixture(
  projectId: string,
  projectName: string,
  branch: string,
): ProjectRepositoriesData {
  const prefix = "C:/fixtures/" + projectName.toLowerCase();
  return {
    projectId,
    catalogRevision: fixtureCatalog.revision,
    repositories: [
      {
        workspaceRoot: workspace,
        repositories: [
          {
            path: workspace,
            access: "served",
            name: projectName + " checkout",
            worktrees: [
              {
                path: prefix + "/trees/current",
                kind: "trees",
                branch,
                missing: false,
                id: projectName.toLowerCase() + "-fixture",
                createdAt: "2026-10-31T00:00:00.000Z",
              },
            ],
          },
          {
            path: prefix + "/approved",
            access: "approved",
            name: projectName + " approved checkout",
            worktrees: [],
          },
          {
            path: prefix + "/unregistered",
            access: "unregistered",
          },
        ],
      },
    ],
  };
}
test.beforeEach(seedProjects);

test("project General settings loads the selected fixture fields", async ({
  page,
}) => {
  let postCount = 0;
  let catalogReads = 0;
  let repositoryReads = 0;
  await page.route("**/__agent-forge/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "POST") {
      postCount++;
      await route.fulfill({ status: 409, body: "Fixture RED blocks writes." });
      return;
    }
    if (
      request.method() === "GET" &&
      url.pathname ===
        "/__agent-forge/projects/" + alpha.id + "/settings/repositories"
    ) {
      repositoryReads++;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          data: repositoryFixture(alpha.id, "Alpha", "alpha-feature"),
          error: null,
        }),
      });
      return;
    }
    if (
      request.method() === "GET" &&
      url.pathname === "/__agent-forge/projects"
    ) {
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
  await expect(page.locator(".af-project-settings-provenance")).toContainText(
    "last-known hearth project catalog",
  );
  await expect(
    page.getByRole("region", {
      name: "Repositories and worktrees",
      exact: true,
    }),
  ).toBeVisible();
  const repositoryRegion = page.getByRole("region", {
    name: "Repositories and worktrees",
    exact: true,
  });
  await expect(
    repositoryRegion.getByText("alpha-feature", { exact: true }),
  ).toBeVisible();
  await expect(repositoryRegion).toContainText("Served checkout");
  await expect(repositoryRegion).toContainText("Approved checkout");
  await expect(repositoryRegion).toContainText("Unregistered repository path");
  await expect(repositoryRegion).toContainText("Reported present");
  expect(repositoryReads).toBe(1);
  const readsBeforeRefresh = catalogReads;
  await page.getByRole("button", { name: "Refresh current settings" }).click();
  await expect(page.locator(".af-project-settings-provenance")).toContainText(
    "current hearth project catalog read",
  );
  await expect.poll(() => catalogReads).toBe(readsBeforeRefresh + 1);
  expect(postCount).toBe(0);
  await page.setViewportSize({ width: 375, height: 812 });
  const dimensions = await repositoryRegion.evaluate((region) => ({
    scrollWidth: region.scrollWidth,
    clientWidth: region.clientWidth,
  }));

  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth);
  const capture = process.env["SHOT_DIR"];
  if (capture) {
    mkdirSync(capture, { recursive: true });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.screenshot({
      path: join(capture, "project-settings-general-desktop.png"),
      fullPage: true,
    });
    await page.setViewportSize({ width: 375, height: 812 });
    await page.screenshot({
      path: join(capture, "project-settings-general-mobile.png"),
      fullPage: true,
    });
    await page.setViewportSize({ width: 1280, height: 900 });
    await repositoryRegion.screenshot({
      path: join(capture, "project-settings-repositories-desktop.png"),
    });
    await page.setViewportSize({ width: 375, height: 812 });
    await repositoryRegion.screenshot({
      path: join(capture, "project-settings-repositories-mobile.png"),
    });
  }
});

test("repository facts are scoped to the selected project and retry only on request", async ({
  page,
}) => {
  const repositoryReads: Record<string, number> = {};
  let postCount = 0;
  await page.route("**/__agent-forge/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "POST") {
      postCount++;
      await route.fulfill({ status: 409, body: "Fixture RED blocks writes." });
      return;
    }
    const match =
      /^\/__agent-forge\/projects\/([^/]+)\/settings\/repositories$/.exec(
        url.pathname,
      );
    if (request.method() === "GET" && match) {
      const projectId = decodeURIComponent(match[1] ?? "");
      const count = (repositoryReads[projectId] ?? 0) + 1;
      repositoryReads[projectId] = count;
      if (projectId === beta.id && count === 1) {
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({
            ok: false,
            data: null,
            error: "Fixture repository read is unavailable.",
          }),
        });
        return;
      }
      const project = projectId === beta.id ? beta : alpha;
      const name = projectId === beta.id ? "Beta" : "Alpha";
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          data: repositoryFixture(
            project.id,
            name,
            name.toLowerCase() + "-feature",
          ),
          error: null,
        }),
      });
      return;
    }
    if (
      request.method() === "GET" &&
      url.pathname === "/__agent-forge/projects"
    ) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, data: fixtureCatalog, error: null }),
      });
      return;
    }
    await route.continue();
  });

  await openSettled(
    page,
    "/index.html#/desktop/project/" + alpha.id + "/project-settings",
  );
  const region = page.getByRole("region", {
    name: "Repositories and worktrees",
    exact: true,
  });
  await expect(region).toContainText("alpha-feature");
  await expect.poll(() => repositoryReads[alpha.id] ?? 0).toBe(1);

  await page.evaluate((projectId) => {
    window.location.hash =
      "#/desktop/project/" + projectId + "/project-settings";
  }, beta.id);
  await expect(page.getByLabel("Project name", { exact: true })).toHaveValue(
    "Beta",
  );
  const betaRegion = page.getByRole("region", {
    name: "Repositories and worktrees",
    exact: true,
  });
  await expect(betaRegion.getByRole("alert")).toBeVisible();
  await expect(
    betaRegion.getByRole("button", { name: "Retry repository refresh" }),
  ).toBeVisible();
  await expect(betaRegion).not.toContainText("alpha-feature");
  expect(repositoryReads[beta.id]).toBe(1);

  await betaRegion
    .getByRole("button", { name: "Retry repository refresh" })
    .click();
  await expect(betaRegion).toContainText("beta-feature");
  expect(repositoryReads[beta.id]).toBe(2);
  expect(postCount).toBe(0);
});
test("repository reconciliation waits for the current selection", async ({
  page,
}) => {
  let summaries = 0;
  let posts = 0;
  const reads: string[] = [];
  let release: (() => void) | undefined;
  await page.route("**/__agent-forge/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const send = (data: unknown) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, data, error: null }),
      });
    if (request.method() === "POST") {
      posts++;
      return route.fulfill({ status: 409 });
    }
    if (path === "/__agent-forge/projects/summary") {
      if (++summaries === 2)
        await new Promise<void>((resolve) => (release = resolve));
      await send({
        catalog: { ...fixtureCatalog, revision: summaries === 1 ? 1 : 2 },
        summaries: [],
        asOf: "2026-11-02T00:00:00.000Z",
      });
      return;
    }
    const id =
      /^\/__agent-forge\/projects\/([^/]+)\/settings\/repositories$/.exec(
        path,
      )?.[1];
    if (request.method() === "GET" && id) {
      const project = id === beta.id ? beta : alpha;
      const data = repositoryFixture(
        id,
        project.name,
        project.slug + "-feature",
      );
      data.catalogRevision = 2;
      reads.push(id);
      await send(data);
      return;
    }
    await route.continue();
  });

  await openSettled(
    page,
    "/index.html#/desktop/project/" + alpha.id + "/project-settings",
  );
  const region = page.getByRole("region", {
    name: "Repositories and worktrees",
    exact: true,
  });
  const refresh = region.getByRole("button", {
    name: "Refresh project catalog",
  });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await refresh.focus();
  expect(await refresh.evaluate((el) => el.matches(":focus-visible"))).toBe(
    true,
  );
  await refresh.press("Enter");
  await expect.poll(() => typeof release).toBe("function");
  await page.evaluate(
    (id) =>
      (window.location.hash = "#/desktop/project/" + id + "/project-settings"),
    beta.id,
  );
  await expect(page.getByLabel("Project name", { exact: true })).toHaveValue(
    "Beta",
  );
  expect(reads).toEqual([alpha.id]);
  release?.();
  await expect(region).toContainText("beta-feature");
  expect(reads).toEqual([alpha.id, beta.id]);
  expect(
    await region.evaluate((el) => getComputedStyle(el).scrollBehavior),
  ).toBe("auto");
  expect(posts).toBe(0);
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
    if (
      request.method() === "GET" &&
      url.pathname === "/__agent-forge/projects"
    ) {
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
  await expect(page.getByLabel("Project name", { exact: true })).toHaveValue(
    "Alpha",
  );
  await page.getByLabel("Project name", { exact: true }).fill(body.name);
  await page
    .getByLabel("Project description", { exact: true })
    .fill(body.description);
  await page
    .getByLabel("Project color", { exact: true })
    .selectOption(body.color);
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
    if (
      request.method() === "GET" &&
      url.pathname === "/__agent-forge/projects"
    ) {
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
  await expect(page.getByLabel("Project name", { exact: true })).toHaveValue(
    "Alpha",
  );
  await page.getByLabel("Project name", { exact: true }).fill(name);
  await page.getByRole("button", { name: "Save General settings" }).click();
  const general = page.getByRole("region", { name: "General" });
  await expect(general.getByRole("status")).toContainText("outcome is unknown");
  expect(postCount).toBe(1);

  await page.getByRole("button", { name: "Check current settings" }).click();
  await expect(general.getByRole("status")).toContainText(
    "earlier outcome remains unknown",
  );
  expect(postCount).toBe(1);
  await page
    .getByRole("button", { name: "I reviewed the current values" })
    .click();
  await page.getByRole("button", { name: "Save General settings" }).click();
  await expect(
    general
      .getByRole("status")
      .filter({ hasText: "Current project settings read" }),
  ).toContainText("Current project settings read at catalog revision 2");
  await expect(
    general.getByRole("status").filter({ hasText: "outcome remains unknown" }),
  ).toBeVisible();
  expect(postCount).toBe(2);
});
