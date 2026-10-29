import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { openSettled } from "../e2e/fixtures";
import { alpha, seedProjects } from "./project-fixtures";

test.beforeEach(seedProjects);

test("project Reviews reserves, convenes, completes, and reloads the verified original and result", async ({
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
    page.getByText("No council reviews yet", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "New review", exact: true }).click();
  await expect(page.getByLabel("Source type")).toHaveValue("text");
  await expect(page.getByLabel("Document or question")).toBeVisible();
  const prepare = page.getByRole("button", {
    name: "Prepare original for review",
  });
  await expect(prepare).toBeDisabled();
  expect(councilPosts).toEqual([]);

  const source = page.getByLabel("Document or question");
  await source.fill(
    "Exact review body: preserve this sentence and its identity.",
  );
  await expect(prepare).toBeEnabled();
  await page
    .getByLabel(
      "Redact detected secrets; otherwise source preparation rejects them",
    )
    .uncheck();
  await expect(source).toHaveValue(
    "Exact review body: preserve this sentence and its identity.",
  );
  await expect(prepare).toBeEnabled();
  await page
    .getByLabel(
      "Redact detected secrets; otherwise source preparation rejects them",
    )
    .check();
  await prepare.click();
  await expect(
    page.getByRole("heading", { name: "Exact saved original" }),
  ).toBeVisible();
  await expect(
    page.getByText(
      "Exact review body: preserve this sentence and its identity.",
    ),
  ).toBeVisible();
  const identitySummary = page.getByText("Request identity and scope", {
    exact: true,
  });
  await identitySummary.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByText(/Intent hash/)).toBeVisible();
  const shotDir = process.env["SHOT_DIR"];
  if (shotDir) {
    mkdirSync(shotDir, { recursive: true });
    const originalHeading = page.getByRole("heading", {
      name: "Exact saved original",
    });
    await originalHeading.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: join(shotDir, "council-exact-original.png"),
      animations: "disabled",
    });
  }
  expect(councilPosts).toHaveLength(1);
  expect(councilPosts[0]).toMatch(/\/projects\/.*\/council\/reviews$/);
  expect(councilPosts.some((path) => path.endsWith("/commit"))).toBe(false);
  expect(councilPosts.some((path) => path.includes("/council-api/runs"))).toBe(
    false,
  );

  await page
    .getByRole("button", { name: "Convene this exact original" })
    .click();
  await expect(
    page.getByRole("heading", { name: "Council result" }),
  ).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("Verified state: completed")).toBeVisible();
  if (shotDir) {
    const resultHeading = page.getByRole("heading", {
      name: "Council result",
    });
    await resultHeading.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: join(shotDir, "council-completed-result.png"),
      animations: "disabled",
    });
  }
  expect(councilPosts).toHaveLength(2);
  expect(councilPosts[1]).toMatch(
    /\/projects\/.*\/council\/reviews\/[^/]+\/commit$/,
  );

  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Saved reviews" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Open result" }).click();
  await expect(
    page.getByRole("heading", { name: "Council result" }),
  ).toBeVisible();
  await expect(page.getByText("Verified state: completed")).toBeVisible();
  await page.getByText("Show exact saved original", { exact: true }).click();
  await page.getByText("Request identity and scope", { exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Exact saved original" }),
  ).toBeVisible();
  await expect(page.getByText(/Intent hash/)).toBeVisible();
  await expect(
    page.getByText("Exact review body: preserve this sentence and its identity."),
  ).toBeVisible();
  await page.getByText("Inspect complete public Council result", { exact: true }).click();
  await expect(page.locator(".af-council-transcript")).toHaveValue(
    /Exact review body: preserve this sentence and its identity\./,
  );
  expect(councilPosts).toHaveLength(2);
});
