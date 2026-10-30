import { expect, test } from "@playwright/test";
import { runsHref } from "../../apps/desktop/src/project-runs-model";
import { openSettled } from "../e2e/fixtures";
import { alpha, seedProjects } from "./project-fixtures";

const protectedPosts: string[] = [];

test.beforeEach(({ page }) => {
  seedProjects();
  protectedPosts.length = 0;
  page.on("request", (request) => {
    const pathname = new URL(request.url()).pathname;
    if (
      request.method() === "POST" &&
      pathname.startsWith("/__agent-forge/")
    )
      protectedPosts.push(pathname);
  });
});

test.afterEach(() => {
  expect(protectedPosts).toEqual([]);
});

test("New forge run opens attended preparation only after the scoped Runs read", async ({
  page,
}) => {
  await openSettled(page, `/index.html${runsHref(alpha.id, null)}`);
  await expect(
    page.getByRole("heading", {
      name: "No forge runs in this served checkout",
      exact: true,
    }),
  ).toBeVisible();

  const runs = page.getByRole("region", { name: "Project forge runs" });
  const launch = runs.getByRole("button", {
    name: "New forge run",
    exact: true,
  });
  await expect(launch).toBeEnabled();
  await launch.click();

  const preparation = page.getByRole("dialog");
  await expect(preparation).toBeVisible();
  await expect(
    preparation.getByRole("button", { name: "Start", exact: true }),
  ).toHaveCount(0);
});
