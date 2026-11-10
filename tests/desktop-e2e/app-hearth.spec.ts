import { mkdirSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";
import { appHearthSettingsSchema } from "../../scripts/desktop/app-hearth-protocol";
import { openSettled } from "../e2e/fixtures";
import { HEARTH_PORT } from "../e2e/servers";
import { captureTextResponseThroughBrowserFetch } from "./browser-response-capture";
import { seedProjects } from "./project-fixtures";

test.beforeEach(seedProjects);
const panel = (page: Page) =>
  page.getByRole("region", { name: "Hearth", exact: true });
async function settings(page: Page) {
  await openSettled(page, "/#/desktop/app-settings");
  await expect(
    page.getByRole("heading", { name: "Hearth", exact: true }),
  ).toBeVisible();
}
test("Hearth Settings reads actual port, logical sizes and the owned nightly backup schedule", async ({
  page,
}) => {
  await settings(page);
  await expect(
    panel(page).getByText("Hearth diagnostics read.", { exact: true }),
  ).toBeVisible();
  const capture = await captureTextResponseThroughBrowserFetch(page, {
    method: "GET",
    origin: new URL(page.url()).origin,
    path: "/__agent-forge/app-settings/hearth",
  });
  let captured: { status: number; text: string };
  try {
    await panel(page)
      .getByRole("button", { name: "Check Hearth diagnostics", exact: true })
      .click();
    captured = await capture.response;
  } finally {
    await capture.dispose();
  }
  expect(captured.status).toBe(200);
  // The assertion consumes retained bytes after the response's document is gone.
  await page.goto("data:text/html,<title>Retire captured document</title>");
  await settings(page);
  let envelope: unknown;
  try {
    envelope = JSON.parse(captured.text);
  } catch {
    throw Error("Captured diagnostics response was not valid JSON");
  }

  if (
    envelope === null ||
    typeof envelope !== "object" ||
    !("ok" in envelope) ||
    envelope.ok !== true ||
    !("data" in envelope)
  )
    throw Error("Missing diagnostics envelope");
  const data = appHearthSettingsSchema.parse(envelope.data);
  expect(data.port).toBe(HEARTH_PORT);
  expect(data.port).not.toBe(Number(new URL(page.url()).port));
  await expect(
    panel(page).getByText(String(HEARTH_PORT), { exact: true }),
  ).toBeVisible();
  await expect(
    panel(page).getByText(data.ledger.path, { exact: true }),
  ).toBeVisible();
  await expect(
    panel(page).getByText(
      "Nightly backups run at 00:00 UTC while Hearth is running.",
      { exact: false },
    ),
  ).toBeVisible();
  expect(data.upkeep.nightlyBackup?.phase).toBe("scheduled");
  if (!data.upkeep.nightlyBackup?.nextAttemptAt)
    throw Error("Missing next backup attempt");
  // The reopened page is a newer observation: its schedule can advance at midnight.
  const nextBackup = panel(page)
    .locator("p")
    .filter({ hasText: /^Next scheduled attempt \(UTC\):/ })
    .locator("time");
  await expect(nextBackup).toHaveCount(1);
  await expect(nextBackup).toBeVisible();
  const displayed = await nextBackup.evaluate((element) => ({
    at: element.getAttribute("datetime"),
    text: element.textContent?.trim(),
  }));
  if (!displayed.at) throw Error("Displayed backup time missing");
  expect(displayed.at).toMatch(/^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/);
  expect(new Date(displayed.at).toISOString()).toBe(displayed.at);
  expect(displayed.text).toBe(displayed.at);
  await expect(
    panel(page).getByText("This status covers this Hearth lifetime only.", {
      exact: false,
    }),
  ).toBeVisible();
  await expect(panel(page).getByText("None.", { exact: false })).toBeVisible();
  await expect(
    panel(page).getByRole("button", { name: "Restart hearth", exact: true }),
  ).toBeEnabled();
  await page.setViewportSize({ width: 1100, height: 700 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  const check = panel(page).getByRole("button", {
    name: "Check Hearth diagnostics",
    exact: true,
  });
  await page.keyboard.press("Tab");
  await check.focus();
  await expect(check).toBeFocused();
  expect(await check.evaluate((el) => getComputedStyle(el).outlineWidth)).toBe(
    "2px",
  );
  expect(await check.evaluate((el) => getComputedStyle(el).outlineStyle)).toBe(
    "solid",
  );
  mkdirSync(".tmp/screenshots/hearth-settings", { recursive: true });
  await page.screenshot({
    path: ".tmp/screenshots/hearth-settings/settings-1100.png",
    mask: [panel(page).getByText(data.ledger.path, { exact: true })],
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await panel(page).screenshot({
    path: ".tmp/screenshots/hearth-settings/hearth-dark.png",
    mask: [panel(page).getByText(data.ledger.path, { exact: true })],
  });
  await page.getByLabel("Theme", { exact: true }).selectOption("light");
  await page
    .getByRole("button", { name: "Save appearance", exact: true })
    .click();
  await expect(page.locator("html")).toHaveAttribute("data-af-theme", "light");
  await expect(check).toBeEnabled();
  await panel(page).screenshot({
    path: ".tmp/screenshots/hearth-settings/hearth-light.png",
    mask: [panel(page).getByText(data.ledger.path, { exact: true })],
  });
  await page.getByLabel("Theme", { exact: true }).selectOption("dark");
  await page
    .getByRole("button", { name: "Save appearance", exact: true })
    .click();
  await expect(page.locator("html")).toHaveAttribute("data-af-theme", "dark");
});
test("failed or malformed diagnostics retain last-read values and recover only through a fresh verified read", async ({
  page,
}) => {
  let mode: "failure" | "live" | "malformed" = "failure";
  await page.route("**/__agent-forge/app-settings/hearth", async (route) => {
    if (mode === "live") return route.continue();
    return route.fulfill({
      status: mode === "failure" ? 503 : 200,
      contentType: "application/json",
      body: JSON.stringify(
        mode === "failure"
          ? { ok: false, data: null, error: "fixture unavailable" }
          : {
              ok: true,
              data: {
                version: 1,
                port: 12345,
                execution: { names: ["RAW_SECRET=value"] },
              },
              error: null,
            },
      ),
    });
  });
  await settings(page);
  await expect(
    panel(page).getByText("No verified diagnostics are available.", {
      exact: true,
    }),
  ).toBeVisible();
  const check = panel(page).getByRole("button", {
    name: "Check Hearth diagnostics",
    exact: true,
  });
  mode = "live";
  await check.click();
  await expect(
    panel(page).getByText(String(HEARTH_PORT), { exact: true }),
  ).toBeVisible();
  mode = "malformed";
  await check.click();
  await expect(
    panel(page)
      .getByRole("alert")
      .filter({ hasText: "Showing last read values" }),
  ).toBeVisible();
  await expect(
    panel(page).getByText(String(HEARTH_PORT), { exact: true }),
  ).toBeVisible();
  await expect(panel(page)).not.toContainText("RAW_SECRET=value");
  mode = "live";
  await check.click();
  await expect(
    panel(page).getByText("Hearth diagnostics read.", { exact: true }),
  ).toBeVisible();
});
test("Settings restart uses the frame recovery owner and preserves its unknown-outcome fence across navigation", async ({
  page,
}) => {
  await settings(page);
  let posts = 0;
  await page.route("**/__agent-forge/desktop/restart", async (route) => {
    posts++;
    await route.abort("failed");
  });
  const restart = panel(page).getByRole("button", {
    name: "Restart hearth",
    exact: true,
  });
  await expect(restart).toBeEnabled();
  await restart.evaluate((button) => {
    (button as HTMLButtonElement).click();
    (button as HTMLButtonElement).click();
  });
  await expect(
    panel(page).getByText("Outcome unknown.", { exact: false }),
  ).toBeVisible();
  await expect(restart).toBeDisabled();
  expect(posts).toBe(1);
  await openSettled(page, "/#/desktop");
  await settings(page);
  await expect(
    panel(page).getByRole("button", { name: "Restart hearth", exact: true }),
  ).toBeDisabled();
  await expect(
    panel(page).getByText("Outcome unknown.", { exact: false }),
  ).toBeVisible();
  expect(posts).toBe(1);
});
