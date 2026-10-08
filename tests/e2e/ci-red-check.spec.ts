import { expect, test } from "@playwright/test";

/**
 * Deliberate failure. Committed once to prove that the CI job goes red and
 * uploads `test-results/`, and reverted in the next commit. It drives a page so
 * that a trace and a failure screenshot exist to upload.
 */
test("deliberate failure: the CI job goes red and uploads its traces", async ({
  page,
}) => {
  await page.goto("/index.html#/commands", { waitUntil: "networkidle" });
  await expect(page.locator("h1")).toHaveText("A heading this page never has", {
    timeout: 2_000,
  });
});
