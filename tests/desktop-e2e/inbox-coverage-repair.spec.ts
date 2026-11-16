import { expect, test } from "@playwright/test";
import { openSettled } from "../e2e/fixtures";
import { alpha, seedProjects } from "./project-fixtures";

test.beforeEach(() => seedProjects());

test("@native-shell-repair Inbox identifies failed source coverage and its retry path", async ({
  page,
}) => {
  let failedReads = 0;
  const writes: string[] = [];
  await page.route("**/__agent-forge/projects/**", async (route) => {
    if (
      route.request().method() === "GET" &&
      new URL(route.request().url()).pathname.includes("session")
    ) {
      failedReads++;
      await route.fulfill({
        status: 503,
        json: {
          ok: false,
          data: null,
          error: "Isolated session source unavailable",
        },
      });
    } else await route.continue();
  });
  page.on("request", (request) => {
    if (request.method() === "POST")
      writes.push(new URL(request.url()).pathname);
  });
  await openSettled(page, `/index.html#/desktop/inbox?project=${alpha.id}`);
  await expect.poll(() => failedReads).toBeGreaterThan(0);
  const coverage = page.getByRole("region", {
    name: "Inbox source coverage",
    exact: true,
  });
  await expect(coverage).toBeVisible();
  await expect(coverage).toContainText("permission");
  await expect(coverage).toContainText(
    "The owned session list could not be verified.",
  );
  await expect(coverage).toContainText("Refresh Inbox");
  await expect(
    page.getByRole("button", { name: "Refresh Inbox", exact: true }),
  ).toBeEnabled();
  expect(writes).toEqual([]);
});
