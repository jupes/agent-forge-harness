import { expect, test } from "@playwright/test";
import { openSettled } from "../e2e/fixtures";
import { alpha, seedProjects } from "./project-fixtures";

test.beforeEach(seedProjects);

test("project Reviews opens review setup without starting a Council run", async ({
  page,
}) => {
  const councilPosts: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (request.method() === "POST" && url.pathname.includes("/council/"))
      councilPosts.push(url.pathname);
  });

  await openSettled(page, `/index.html#/desktop/project/${alpha.id}/overview`);
  await page.getByRole("link", { name: "Reviews", exact: true }).click();
  await expect(page).toHaveURL(
    new RegExp(`/desktop/project/${alpha.id}/reviews$`),
  );
  await expect(
    page.getByText("No council reviews yet.", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "New review", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "New review", exact: true }),
  ).toBeVisible();
  expect(councilPosts).toEqual([]);
});
