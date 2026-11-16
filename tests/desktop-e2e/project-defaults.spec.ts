import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { openSettled, reloadSettled } from "../e2e/fixtures";
import {
  alpha,
  catalogFile,
  catalog as fixtureCatalog,
  seedProjects,
} from "./project-fixtures";

test("project provider and launch defaults save, reload and prefill a fresh composer without starting work", async ({
  page,
}) => {
  seedProjects();
  const projectId = `project-${randomUUID()}`;
  writeFileSync(
    catalogFile,
    JSON.stringify({
      ...fixtureCatalog,
      projects: fixtureCatalog.projects.map((project) =>
        project.id === alpha.id ? { ...project, id: projectId } : project,
      ),
    }),
  );
  await openSettled(
    page,
    `/index.html#/desktop/project/${projectId}/project-settings`,
  );
  const section = page.getByRole("region", {
    name: "Session defaults",
    exact: true,
  });
  const choice = section.getByRole("combobox", {
    name: "Default Claude Smith",
    exact: true,
  });
  await expect(choice).toBeEnabled();
  await choice.selectOption("claude-journeyman");
  await section
    .getByRole("combobox", { name: "Default Codex Smith", exact: true })
    .selectOption("codex-journeyman");
  await section
    .getByRole("combobox", { name: "Where it runs", exact: true })
    .selectOption("existing");
  await section
    .getByRole("combobox", { name: "Run as", exact: true })
    .selectOption("task");
  let releaseSmiths: (() => void) | undefined;
  const heldSmiths = new Promise<void>((resolve) => {
    releaseSmiths = resolve;
  });
  const smithsPath = "**/__agent-forge/smiths";
  const pendingSmiths = new Set<Promise<void>>();
  await page.route(smithsPath, (route) => {
    const finished = (async () => {
      if (route.request().method() !== "GET") return route.continue();
      const response = await route.fetch({
        headers: {
          ...(await route.request().allHeaders()),
          Origin: new URL(route.request().url()).origin,
          "Sec-Fetch-Site": "same-origin",
        },
      });
      expect(response.status()).toBe(200);
      await heldSmiths;
      await route.fulfill({ response });
    })();
    pendingSmiths.add(finished);
    return finished.finally(() => pendingSmiths.delete(finished));
  });
  try {
    await section
      .getByRole("button", { name: "Save session defaults", exact: true })
      .click();
    await expect(
      section
        .getByRole("status")
        .filter({ hasText: "Loading configured Smiths" }),
    ).toBeVisible();
    await expect(
      section
        .getByRole("status")
        .filter({ hasText: "Session defaults settings read at revision 2." }),
    ).toBeVisible();
  } finally {
    releaseSmiths?.();
    await Promise.all([...pendingSmiths]);
    await page.unroute(smithsPath);
  }
  await reloadSettled(page);
  await expect(choice).toHaveValue("claude-journeyman");
  await expect(
    section.getByRole("combobox", { name: "Default Codex Smith", exact: true }),
  ).toHaveValue("codex-journeyman");
  await expect(
    section.getByRole("combobox", { name: "Where it runs", exact: true }),
  ).toHaveValue("existing");
  await expect(
    section.getByRole("combobox", { name: "Run as", exact: true }),
  ).toHaveValue("task");
  let starts = 0;
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      request.url().endsWith(`/projects/${projectId}/sessions`)
    )
      starts++;
  });
  await openSettled(page, `/index.html#/desktop/project/${projectId}/sessions`);
  await page.getByRole("button", { name: "New session", exact: true }).click();
  const dialog = page.getByRole("dialog", {
    name: "New session · Alpha",
    exact: true,
  });
  await expect(
    dialog.getByRole("combobox", { name: "Session smith", exact: true }),
  ).toHaveValue("claude-journeyman");
  await expect(dialog).toContainText("project Settings (claude-journeyman)");
  await expect(
    dialog.getByRole("combobox", {
      name: "Where the session runs",
      exact: true,
    }),
  ).toHaveValue("existing");
  await expect(
    dialog.getByRole("combobox", { name: "Session mode", exact: true }),
  ).toHaveValue("task");
  expect(starts).toBe(0);
});
