import { mkdirSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";
import {
  type HearthLogSnapshot,
  hearthLogSnapshotSchema,
} from "../../scripts/desktop/app-hearth-log-protocol";
import { openSettled } from "../e2e/fixtures";
import { seedProjects } from "./project-fixtures";

test.beforeEach(seedProjects);
const generation = "ae000000-0000-4000-8000-000000000001";
const at = "2026-11-11T00:00:00Z";
const sample: HearthLogSnapshot = hearthLogSnapshotSchema.parse({
  version: 1,
  generation,
  startedAt: at,
  checkedAt: at,
  latestSequence: 300,
  retainedCount: 256,
  evictedCount: 44,
  omittedRetainedCount: 128,
  entries: Array.from({ length: 128 }, (_, index) => ({
    sequence: 173 + index,
    at,
    code: index === 127 ? "ledger.failed" : "ledger.inserted",
    level: index === 127 ? "warning" : "info",
    eventKind: "operator.action",
  })),
});
const panel = (page: Page) =>
  page.getByRole("region", { name: "Hearth service log", exact: true });
const check = (page: Page) =>
  panel(page).getByRole("button", {
    name: "Check Hearth service log",
    exact: true,
  });
const answer = (data: HearthLogSnapshot) => ({
  status: 200,
  contentType: "application/json",
  body: JSON.stringify({ ok: true, data, error: null }),
});

test("service log shows bounded loss counts, keyboard filtering and scrolling in dark and light minimum layouts", async ({
  page,
}) => {
  let reads = 0;
  await page.route(
    "**/__agent-forge/app-settings/hearth/logs",
    async (route) => {
      expect(route.request().method()).toBe("GET");
      reads++;
      return route.fulfill(answer(sample));
    },
  );
  await page.setViewportSize({ width: 1100, height: 700 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openSettled(page, "/#/desktop/app-settings");
  const region = panel(page);
  await expect(region.getByText(generation, { exact: true })).toBeVisible();
  await expect(region.getByText("256", { exact: true })).toBeVisible();
  await expect(region.getByText("44", { exact: true })).toBeVisible();
  await expect(region.getByText("128", { exact: true })).toBeVisible();
  await expect(
    region.getByText(/Showing 128 of 128 latest returned observations/),
  ).toBeVisible();
  await expect(
    region.getByText(/does not confirm action completion/),
  ).toBeVisible();
  const filter = region.getByRole("combobox", { name: "Show observations" });
  await filter.focus();
  await page.keyboard.press("w");
  await page.keyboard.press("Enter");
  await expect(filter).toHaveValue("warnings");
  await expect(region.getByRole("listitem")).toHaveCount(1);
  await expect(
    region.getByText(/Showing 1 of 128 latest returned observations/),
  ).toBeVisible();
  await expect(
    region.getByText(
      "Ledger append returned a failure; no stored row was confirmed.",
      { exact: true },
    ),
  ).toBeVisible();
  await filter.selectOption("all");
  const scroll = region.getByRole("region", {
    name: "Hearth log entries",
    exact: true,
  });
  await scroll.focus();
  await expect(scroll).toBeFocused();
  expect(
    await scroll.evaluate((element) => getComputedStyle(element).outlineWidth),
  ).toBe("2px");
  expect(
    await scroll.evaluate((element) => element.clientHeight),
  ).toBeLessThanOrEqual(320);
  await page.keyboard.press("End");
  await expect
    .poll(() => scroll.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(0);
  expect(
    await filter.evaluate((element) => element.getBoundingClientRect().height),
  ).toBeGreaterThanOrEqual(32);
  expect(
    await check(page).evaluate(
      (element) => element.getBoundingClientRect().height,
    ),
  ).toBeGreaterThanOrEqual(32);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  mkdirSync("test-results/hearth-log-evidence", { recursive: true });
  await page.getByLabel("Theme", { exact: true }).selectOption("dark");
  await page
    .getByRole("button", { name: "Save appearance", exact: true })
    .click();
  await expect(page.locator("html")).toHaveAttribute("data-af-theme", "dark");
  await page.setViewportSize({ width: 1440, height: 1000 });
  await region.scrollIntoViewIfNeeded();
  await region.screenshot({
    path: "test-results/hearth-log-evidence/dark.png",
  });
  await page.setViewportSize({ width: 1100, height: 700 });
  await page.getByLabel("Theme", { exact: true }).selectOption("light");
  await page
    .getByRole("button", { name: "Save appearance", exact: true })
    .click();
  await expect(page.locator("html")).toHaveAttribute("data-af-theme", "light");
  await page.keyboard.press("Tab");
  await scroll.focus();
  await expect(scroll).toBeFocused();
  expect(
    await scroll.evaluate((element) => element.matches(":focus-visible")),
  ).toBe(true);
  expect(
    await scroll.evaluate((element) => getComputedStyle(element).outlineWidth),
  ).toBe("2px");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await region.scrollIntoViewIfNeeded();
  await region.screenshot({
    path: "test-results/hearth-log-evidence/light.png",
  });
  await page.getByLabel("Theme", { exact: true }).selectOption("dark");
  await page
    .getByRole("button", { name: "Save appearance", exact: true })
    .click();
  await expect(page.locator("html")).toHaveAttribute("data-af-theme", "dark");
  expect(reads).toBeGreaterThan(0);
});

test("failed and unsupported reads retain the selected filter and labelled snapshot; a new lifetime replaces it", async ({
  page,
}) => {
  let mode: "data" | "failure" | "unsupported" | "malformed" = "data";
  let current = sample;
  await page.route(
    "**/__agent-forge/app-settings/hearth/logs",
    async (route) => {
      expect(route.request().method()).toBe("GET");
      if (mode === "failure") return route.abort("failed");
      if (mode === "unsupported")
        return route.fulfill({ status: 404, body: "unsupported" });
      if (mode === "malformed")
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            ok: true,
            data: { raw: "PRIVATE_ERROR" },
            error: null,
          }),
        });
      return route.fulfill(answer(current));
    },
  );
  await openSettled(page, "/#/desktop/app-settings");
  const region = panel(page);
  await expect(region.getByText(generation, { exact: true })).toBeVisible();
  const filter = region.getByRole("combobox", { name: "Show observations" });
  await filter.selectOption("warnings");
  for (const next of ["failure", "malformed", "unsupported"] as const) {
    mode = next;
    await check(page).click();
    await expect(region.getByRole("alert")).toContainText(
      "could not be verified",
    );
    await expect(
      region.getByText(
        "Showing the last read snapshot; it may be out of date.",
        { exact: true },
      ),
    ).toBeVisible();
    await expect(filter).toHaveValue("warnings");
    await expect(region.getByRole("listitem")).toHaveCount(1);
    await expect(region.getByText(generation, { exact: true })).toBeVisible();
    await expect(region).not.toContainText("PRIVATE_ERROR");
  }
  await expect(region.getByText(/unsupported by this Hearth/)).toBeVisible();
  current = {
    ...sample,
    generation: "ae000000-0000-4000-8000-000000000002",
    latestSequence: 1,
    retainedCount: 1,
    evictedCount: 0,
    omittedRetainedCount: 0,
    entries: [
      {
        sequence: 1,
        at,
        code: "runtime.created",
        level: "info",
        eventKind: null,
      },
    ],
  };
  mode = "data";
  await check(page).click();
  await expect(
    region.getByText(/A new Hearth lifetime replaced/),
  ).toBeVisible();
  await expect(
    region.getByText(current.generation, { exact: true }),
  ).toBeVisible();
  await expect(region.getByText(generation, { exact: true })).toHaveCount(0);
  await expect(filter).toHaveValue("warnings");
  await expect(region.getByRole("listitem")).toHaveCount(0);
  await expect(
    region.getByText(/No warnings in the latest returned observations/),
  ).toBeVisible();
  await expect(
    region.getByText("Showing the last read snapshot; it may be out of date.", {
      exact: true,
    }),
  ).toHaveCount(0);
});

test("unsupported and valid empty service logs have separate initial states", async ({
  page,
}) => {
  let supported = false;
  const empty = {
    ...sample,
    latestSequence: 0,
    retainedCount: 0,
    evictedCount: 0,
    omittedRetainedCount: 0,
    entries: [],
  };
  await page.route("**/__agent-forge/app-settings/hearth/logs", (route) =>
    supported
      ? route.fulfill(answer(empty))
      : route.fulfill({ status: 404, body: "unsupported" }),
  );
  await openSettled(page, "/#/desktop/app-settings");
  const region = panel(page);
  await expect(
    region.getByText(/No verified service log snapshot is available/),
  ).toBeVisible();
  await expect(
    region.getByText(/No observations were returned for this Hearth lifetime/),
  ).toHaveCount(0);
  supported = true;
  await check(page).click();
  await expect(
    region.getByText(
      "No observations were returned for this Hearth lifetime.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(region.getByText(/unsupported by this Hearth/)).toHaveCount(0);
});
