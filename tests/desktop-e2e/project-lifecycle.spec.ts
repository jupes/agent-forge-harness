import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { openSettled, reloadSettled } from "../e2e/fixtures";
import { alpha, catalog, catalogFile, seedProjects } from "./project-fixtures";

test("archive persists and a lost delete reply recovers only its exact receipt after reload", async ({
  page,
}) => {
  seedProjects();
  const id = `project-${randomUUID()}`;
  writeFileSync(
    catalogFile,
    JSON.stringify({
      ...catalog,
      projects: catalog.projects.map((project) =>
        project.id === alpha.id ? { ...project, id } : project,
      ),
    }),
  );
  await openSettled(
    page,
    `/index.html#/desktop/project/${id}/project-settings`,
  );
  const section = page.getByRole("region", {
    name: "Archive or delete project",
    exact: true,
  });
  await section
    .getByRole("button", { name: "Archive project", exact: true })
    .click();
  await expect(
    section.getByRole("button", { name: "Unarchive project", exact: true }),
  ).toBeEnabled();
  await reloadSettled(page);
  await expect(section).toContainText("Saved archive preference: archived");
  await section
    .getByRole("button", { name: "Check deletion eligibility", exact: true })
    .click();
  await expect(section).toContainText("eligible");
  const name = section.getByRole("textbox", {
      name: "Project name to confirm deletion",
      exact: true,
    }),
    remove = section.getByRole("button", {
      name: "Delete project record",
      exact: true,
    });
  await name.fill("Wrong name");
  await expect(remove).toBeDisabled();
  await name.fill(alpha.name);
  await expect(remove).toBeEnabled();
  let posts = 0;
  await page.route(
    `**/__agent-forge/projects/${id}/settings/deletion`,
    async (route) => {
      if (route.request().method() !== "POST") {
        await route.continue();
        return;
      }
      posts++;
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      await route.abort("failed");
    },
  );
  await remove.click();
  await expect(section).toContainText("Deletion outcome unknown");
  expect(posts).toBe(1);
  await reloadSettled(page);
  await section
    .getByRole("button", {
      name: "Check original deletion receipt",
      exact: true,
    })
    .click();
  await expect(section).toContainText(`Deleted ${alpha.name}`);
  await expect(section).toContainText("Original UUID:");
  expect(posts).toBe(1);
  await expect(
    section.getByRole("button", { name: "Delete project record", exact: true }),
  ).toHaveCount(0);
});
