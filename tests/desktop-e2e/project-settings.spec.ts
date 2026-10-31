import { expect, test } from "@playwright/test";
import { openSettled } from "../e2e/fixtures";
import { alpha, seedProjects } from "./project-fixtures";

test.beforeEach(seedProjects);

test("project General settings loads the selected fixture fields", async ({
  page,
}) => {
  await page.route("**/__agent-forge/**", async (route) => {
    if (route.request().method() === "POST") {
      await route.fulfill({ status: 409, body: "Fixture RED blocks writes." });
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
});
