import { expect, test } from "@playwright/test";
import { openSettled } from "../e2e/fixtures";
import { seedProjects } from "./project-fixtures";

test.beforeEach(seedProjects);

test("palette input entered before passive effects finish survives the opening reset", async ({
  page,
}) => {
  // Clock controls RAF/timers, while Preact's default Promise render queue stays live.
  // Install before navigation: https://playwright.dev/docs/clock.
  await page.clock.install();
  await openSettled(page, "/#/desktop");
  const pauseAt = await page.evaluate(() => Date.now() + 1000);
  await page.clock.pauseAt(pauseAt);
  const dialog = page.getByRole("dialog", {
    name: "Command palette",
    exact: true,
  });
  const search = dialog.getByRole("combobox");
  try {
    // Keyboard/fill do not need the stable animation frames required by clicks.
    await page.keyboard.press("Control+k");
    await expect(search).toBeVisible();
    await search.fill("Toggle theme");
    await expect(search).toHaveValue("Toggle theme");
  } finally {
    // Indexing also uses passive effects. Resume before result/focus/teardown work.
    await page.clock.resume();
  }
  await expect(search).toHaveValue("Toggle theme");
  await expect(
    dialog.getByRole("option").filter({ hasText: "Toggle theme" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
});
