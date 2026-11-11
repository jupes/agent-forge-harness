import { expect, type Page, test } from "@playwright/test";
import {
  type StartupRequest,
  type StartupStatus,
  startupRequestSchema,
} from "../../scripts/desktop/app-startup-protocol";
import { openSettled, reloadSettled } from "../e2e/fixtures";
import { seedProjects } from "./project-fixtures";

test.beforeEach(seedProjects);
type Available = Extract<StartupStatus, { capability: "available" }>;
const ready: Available = {
  capability: "available",
  installationKey: "e".repeat(64),
  registration: "disabled",
  fingerprint: "absent",
  record: { version: 1, revision: 0, last: null },
  checkedAt: "2026-11-10T12:00:00Z",
  canSave: true,
};
const completed = (request: StartupRequest): Available => ({
  ...ready,
  registration: request.enabled ? "enabled" : "disabled",
  fingerprint: request.enabled ? request.installationKey : "absent",
  record: {
    version: 1,
    revision: request.expectedRevision + 1,
    last: { request, startedAt: ready.checkedAt, state: "completed" },
  },
});
const json = (data: StartupStatus) => ({
  status: 200,
  contentType: "application/json",
  body: JSON.stringify({ ok: true, data, error: null }),
});
const panel = (page: Page) =>
  page.getByRole("region", { name: "Launch at login", exact: true });

test("startup checkbox drafts, keyboard Cancel writes nothing, and explicit saves enable and disable the reviewed installation once", async ({
  page,
}) => {
  let snapshot = ready,
    posts = 0,
    release = () => {};
  const held = new Promise<void>((done) => {
    release = done;
  });
  await page.route("**/__agent-forge/desktop/startup", async (route) => {
    if (route.request().method() === "GET")
      return route.fulfill(json(snapshot));
    posts++;
    const request = startupRequestSchema.parse(route.request().postDataJSON());
    expect(request.installationKey).toBe(ready.installationKey);
    expect(request.expectedRevision).toBe(snapshot.record.revision);
    await held;
    snapshot = completed(request);
    await route.fulfill(json(snapshot));
  });
  try {
    await openSettled(page, "/#/desktop/app-settings");
    const region = panel(page),
      check = region.getByRole("checkbox"),
      save = region.getByRole("button", {
        name: "Save startup setting",
        exact: true,
      });
    await expect(check).toBeEnabled();
    await expect(save).toBeDisabled();
    expect(posts).toBe(0);
    await page.keyboard.press("Tab");
    await check.focus();
    expect(
      await check.evaluate((el) => getComputedStyle(el).outlineWidth),
    ).toBe("2px");
    await page.keyboard.press("Space");
    await expect(save).toBeEnabled();
    expect(posts).toBe(0);
    const cancel = region.getByRole("button", {
      name: "Cancel startup draft",
      exact: true,
    });
    await cancel.focus();
    await page.keyboard.press("Enter");
    await expect(check).not.toBeChecked();
    await expect(save).toBeDisabled();
    expect(posts).toBe(0);
    await check.check();
    await save.focus();
    await page.keyboard.press("Enter");
    await expect(save).toBeDisabled();
    await expect(check).toBeDisabled();
    await expect.poll(() => posts).toBe(1);
    release();
    await expect(
      region.getByText("Current registration: Enabled for this installation.", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(check).toBeChecked();
    await expect(save).toBeDisabled();
    await check.uncheck();
    await save.click();
    await expect(
      region.getByText("Current registration: Not registered.", {
        exact: true,
      }),
    ).toBeVisible();
    expect(posts).toBe(2);
    await expect(check).not.toBeChecked();
    await expect(save).toBeDisabled();
    await page.setViewportSize({ width: 1100, height: 700 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  } finally {
    release();
  }
});

test("a lost startup save survives reload and current registration alone cannot clear the exact pending request", async ({
  page,
}) => {
  let snapshot: StartupStatus = ready,
    request: StartupRequest | null = null,
    posts = 0;
  await page.route("**/__agent-forge/desktop/startup", async (route) => {
    if (route.request().method() === "GET")
      return route.fulfill(json(snapshot));
    posts++;
    request = startupRequestSchema.parse(route.request().postDataJSON());
    await route.abort("failed");
  });
  await openSettled(page, "/#/desktop/app-settings");
  const region = panel(page),
    check = region.getByRole("checkbox"),
    save = region.getByRole("button", {
      name: "Save startup setting",
      exact: true,
    });
  await expect(check).toBeEnabled();
  await check.check();
  await save.click();
  await expect(
    region.getByText("Startup save outcome is unknown.", { exact: false }),
  ).toBeVisible();
  snapshot = {
    ...ready,
    registration: "enabled",
    fingerprint: ready.installationKey,
  };
  await reloadSettled(page);
  await expect(save).toBeDisabled();
  await expect(check).toBeDisabled();
  await expect(
    region.getByText("Startup save outcome is unknown.", { exact: false }),
  ).toBeVisible();
  expect(posts).toBe(1);
  if (!request) throw Error("Missing captured request");
  snapshot = completed(request);
  await region
    .getByRole("button", { name: "Check startup registration", exact: true })
    .click();
  await expect(
    region.getByText(
      "Original startup save confirmed; current registration read.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(check).toBeEnabled();
  await expect(check).toBeChecked();
  await expect(save).toBeDisabled();
  expect(posts).toBe(1);
});

test("a window without the native startup service reports unsupported without an off state or write control", async ({
  page,
}) => {
  let posts = 0;
  await page.route("**/__agent-forge/desktop/startup", (route) => {
    if (route.request().method() === "POST") posts++;
    return route.fulfill({ status: 404, body: "Not found" });
  });
  await openSettled(page, "/#/desktop/app-settings");
  const region = panel(page);
  await expect(
    region.getByText("Startup registration is unavailable from this window.", {
      exact: false,
    }),
  ).toBeVisible();
  await expect(region.getByRole("checkbox")).toHaveCount(0);
  await expect(
    region.getByRole("button", { name: "Save startup setting", exact: true }),
  ).toHaveCount(0);
  expect(posts).toBe(0);
});
