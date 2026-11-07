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

test("project Claude default saves, reloads and prefills a fresh composer without starting work", async ({
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
    .getByRole("button", { name: "Save session defaults", exact: true })
    .click();
  await expect(section.getByRole("status")).toContainText("read at revision 2");
  await reloadSettled(page);
  await expect(choice).toHaveValue("claude-journeyman");
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
  expect(starts).toBe(0);
});
