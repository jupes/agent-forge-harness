import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { openSettled, reloadSettled } from "../e2e/fixtures";
import { alpha, catalog, catalogFile, seedProjects } from "./project-fixtures";

test("project admission budgets save and reload with truthful cost provenance", async ({
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
  const section = page.getByRole("region", { name: "Budgets", exact: true });
  const shift = section.getByRole("textbox", {
    name: "Shift spend cap (USD)",
    exact: true,
  });
  const daily = section.getByRole("textbox", {
    name: "Daily API-key admission cap (USD)",
    exact: true,
  });
  await expect(shift).toBeEnabled();
  await shift.fill("5");
  await daily.fill("10");
  await section
    .getByRole("button", { name: "Save project budgets", exact: true })
    .click();
  await expect(section).toContainText("Project budgets read at revision 2");
  await reloadSettled(page);
  await expect(shift).toHaveValue("5");
  await expect(daily).toHaveValue("10");
  await expect(section).toContainText("UTC admission day");
  await expect(section).toContainText("Outstanding allocated USD");
  await expect(section).toContainText("not provider account balances");
});
