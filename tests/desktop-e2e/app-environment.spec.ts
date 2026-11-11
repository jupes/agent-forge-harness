import { expect, type Page, test } from "@playwright/test";
import {
  type EnvironmentRequest,
  type EnvironmentStatus,
  environmentRequestSchema,
} from "../../scripts/config/environment-protocol";
import { openSettled, reloadSettled } from "../e2e/fixtures";
import { seedProjects } from "./project-fixtures";

test.beforeEach(seedProjects);
const ready: EnvironmentStatus = {
  version: 1,
  ownerKey: "a".repeat(64),
  target: "workspace",
  file: "C:/isolated-fixture/agent-forge.toml",
  names: ["OLD_ALLOWED"],
  baseNames: ["PATH", "HOME"],
  provenance: "C:/isolated-fixture/agent-forge.toml",
  revision: { user: "b".repeat(64), workspace: "c".repeat(64) },
  record: { version: 1, revision: 0, last: null },
  checkedAt: "2026-11-11T04:00:00Z",
  canSave: true,
};
const panel = (page: Page) =>
  page.getByRole("region", {
    name: "Execution environment controls",
    exact: true,
  });
const answer = (data: EnvironmentStatus) => ({
  status: 200,
  contentType: "application/json",
  body: JSON.stringify({ ok: true, data, error: null }),
});
const complete = (request: EnvironmentRequest): EnvironmentStatus => ({
  ...ready,
  names: request.names,
  record: {
    version: 1,
    revision: request.expectedJournalRevision + 1,
    last: {
      request,
      candidateHash: "d".repeat(64),
      state: "completed",
      startedAt: ready.checkedAt,
      finishedAt: ready.checkedAt,
    },
  },
});

test("environment names support keyboard draft, Cancel, review and one pending save without values at minimum width", async ({
  page,
}) => {
  let posts = 0,
    snapshot = ready,
    release = () => {};
  const held = new Promise<void>((done) => {
    release = done;
  });
  await page.route(
    "**/__agent-forge/app-settings/environment",
    async (route) => {
      if (route.request().method() === "GET")
        return route.fulfill(answer(snapshot));
      posts++;
      const request = environmentRequestSchema.parse(
        route.request().postDataJSON(),
      );
      expect(request.names).toEqual(["TEAM_TOKEN"]);
      expect(request.expectedRevision).toEqual(ready.revision);
      await held;
      snapshot = complete(request);
      return route.fulfill(answer(snapshot));
    },
  );
  try {
    await page.setViewportSize({ width: 1100, height: 700 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await openSettled(page, "/#/desktop/app-settings");
    const region = panel(page),
      field = region.getByRole("textbox", {
        name: "Additional variable names, one per line",
        exact: true,
      }),
      review = region.getByRole("button", {
        name: "Review environment changes",
        exact: true,
      });
    await expect(field).toHaveValue("OLD_ALLOWED");
    await field.focus();
    await expect(field).toBeFocused();
    expect(
      await field.evaluate((element) => getComputedStyle(element).outlineWidth),
    ).toBe("2px");
    await field.fill("DISCARDED");
    const cancel = region.getByRole("button", {
      name: "Cancel environment changes",
      exact: true,
    });
    await cancel.focus();
    await page.keyboard.press("Enter");
    await expect(field).toHaveValue("OLD_ALLOWED");
    expect(posts).toBe(0);
    await field.fill("TOKEN=value");
    await expect(review).toBeDisabled();
    await field.fill("TEAM_TOKEN");
    await review.focus();
    await page.keyboard.press("Enter");
    await expect(
      region.getByRole("group", { name: "Review before saving", exact: true }),
    ).toBeVisible();
    const save = region.getByRole("button", {
      name: "Save environment names",
      exact: true,
    });
    await save.focus();
    await page.keyboard.press("Enter");
    await expect.poll(() => posts).toBe(1);
    await expect(field).toBeDisabled();
    await expect(cancel).toBeDisabled();
    release();
    await expect(
      region.getByText(
        "That receipt describes the earlier publication; current configuration may differ.",
        { exact: false },
      ),
    ).toBeVisible();
    await expect(field).toBeEnabled();
    await expect(region.getByText("TEAM_TOKEN", { exact: true })).toBeVisible();
    await expect(review).toBeDisabled();
    expect(posts).toBe(1);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    const box = await field.boundingBox();
    expect(box?.height).toBeGreaterThanOrEqual(24);
  } finally {
    release();
  }
});

test("a lost environment reply survives reload and only its exact receipt clears the held original", async ({
  page,
}) => {
  let posts = 0,
    original: EnvironmentRequest | null = null,
    snapshot = ready;
  await page.route(
    "**/__agent-forge/app-settings/environment",
    async (route) => {
      if (route.request().method() === "GET")
        return route.fulfill(answer(snapshot));
      posts++;
      original = environmentRequestSchema.parse(route.request().postDataJSON());
      return route.abort("failed");
    },
  );
  await openSettled(page, "/#/desktop/app-settings");
  const region = panel(page),
    field = region.getByRole("textbox");
  await expect(field).toBeEnabled();
  await field.fill("TEAM_TOKEN");
  await region
    .getByRole("button", { name: "Review environment changes", exact: true })
    .click();
  await region
    .getByRole("button", { name: "Save environment names", exact: true })
    .click();
  await expect(
    region.getByText("Unconfirmed save:", { exact: false }),
  ).toBeVisible();
  snapshot = { ...ready, names: ["TEAM_TOKEN"] };
  await reloadSettled(page);
  await expect(
    region.getByText("Unconfirmed save:", { exact: false }),
  ).toBeVisible();
  await expect(field).toBeDisabled();
  expect(posts).toBe(1);
  if (!original) throw Error("Missing captured original");
  snapshot = { ...complete(original), names: ["LATER_EXTERNAL"] };
  await region
    .getByRole("button", { name: "Check environment settings", exact: true })
    .click();
  await expect(
    region.getByText("Unconfirmed save:", { exact: false }),
  ).toHaveCount(0);
  await expect(field).toBeEnabled();
  await expect(field).toHaveValue("TEAM_TOKEN");
  await expect(
    region.getByText("LATER_EXTERNAL", { exact: true }),
  ).toBeVisible();
  expect(posts).toBe(1);
});

test("unsupported environment controls never infer an empty list or expose a save editor", async ({
  page,
}) => {
  let posts = 0;
  await page.route("**/__agent-forge/app-settings/environment", (route) => {
    if (route.request().method() !== "GET") posts++;
    return route.fulfill({
      status: 404,
      contentType: "application/json",
      body: JSON.stringify({ ok: false, data: null, error: "unsupported" }),
    });
  });
  await openSettled(page, "/#/desktop/app-settings");
  const region = panel(page);
  await expect(
    region.getByText("Environment controls are unsupported in this window.", {
      exact: false,
    }),
  ).toBeVisible();
  await expect(region.getByRole("textbox")).toHaveCount(0);
  await expect(
    region.getByRole("button", { name: "Save environment names", exact: true }),
  ).toHaveCount(0);
  await expect(
    region.getByText("None (fixed base names still apply).", { exact: true }),
  ).toHaveCount(0);
  expect(posts).toBe(0);
});
