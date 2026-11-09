// Preserved deferred1.1 scenario; intentionally outside the1.0 *.spec.ts collection.
// Re-enable with the notification feature and its actual native acceptance.
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { openSettled, reloadSettled } from "../e2e/fixtures";
import { alpha, catalog, catalogFile, seedProjects } from "./project-fixtures";

test("project notification preferences save and reload independently", async ({
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
    name: "Notifications",
    exact: true,
  });
  const gate = section.getByRole("checkbox", {
    name: "Gate failed",
    exact: true,
  });
  const approval = section.getByRole("checkbox", {
    name: "Bead awaiting approval",
    exact: true,
  });
  await expect(gate).toBeEnabled();
  await expect(gate).not.toBeChecked();
  await gate.check();
  await approval.check();
  await section
    .getByRole("button", { name: "Save notification preferences", exact: true })
    .click();
  await expect(
    section
      .getByRole("status")
      .filter({ hasText: "Notification preferences read at revision" }),
  ).toContainText("Notification preferences read at revision 2");
  await reloadSettled(page);
  await expect(gate).toBeChecked();
  await expect(approval).toBeChecked();
  await expect(
    section.getByRole("checkbox", { name: "Shift halted", exact: true }),
  ).not.toBeChecked();
  await expect(
    section.getByRole("checkbox", { name: "Council verdict", exact: true }),
  ).not.toBeChecked();
});
