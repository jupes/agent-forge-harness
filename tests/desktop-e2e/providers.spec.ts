import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { providerReadinessPageSchema } from "../../scripts/providers/protocol";
import { providerReadinessFixture } from "../../scripts/providers/testing";
import { HEARTH_HOME } from "../e2e/servers";
import { alpha, seedProjects, workspace } from "./project-fixtures";

test.beforeEach(() => seedProjects());
const starts = () => {
  const file = join(HEARTH_HOME, "keeper-fixture-starts.jsonl");
  return existsSync(file)
    ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).length
    : 0;
};

test("five factual provider cards run the audited non-generating doctor and share usage through navigation", async ({
  page,
}) => {
  const before = starts();
  await page.goto("/index.html#/desktop/providers");
  await expect(
    page.getByRole("heading", { name: "Providers & usage", exact: true }),
  ).toBeVisible();
  for (const name of ["Claude", "Codex", "Gemini", "Grok", "OpenRouter"])
    await expect(
      page.getByRole("article", { name, exact: true }),
    ).toBeVisible();
  const claude = page.getByRole("article", { name: "Claude", exact: true });
  await expect(
    claude.getByText("API key", { exact: true }).first(),
  ).toBeVisible();
  const reply = page.waitForResponse(
    (response) =>
      response.url().endsWith("/providers/claude/doctor") &&
      response.request().method() === "POST",
  );
  await claude
    .getByRole("button", { name: "Run doctor · Claude", exact: true })
    .click();
  const response = await reply;
  expect(response.status()).toBe(200);
  const envelope = await response.json();
  expect(envelope.ok).toBe(true);
  const report = providerReadinessPageSchema.parse(envelope.data);
  expect(report.providers[0]?.authentication.mode).toBe("api-key");
  expect(JSON.stringify(report)).not.toContain(
    "inert-browser-fixture-not-a-key",
  );
  expect(starts()).toBe(before);
  await page.getByRole("link", { name: "Projects", exact: true }).click();
  await expect(
    page
      .getByRole("region", { name: "Subscriptions", exact: true })
      .getByText("Usage — not reported"),
  ).toHaveCount(5);
  expect(
    await page
      .locator('.af-desktop-title-actions a[aria-label^="Providers and usage"]')
      .getAttribute("title"),
  ).toContain("Claude: Usage — not reported");
});

test("reported units, missing reset, filtered empty and compact keyboard focus never turn unknown allowance into zero", async ({
  page,
}) => {
  const data = providerReadinessFixture(workspace, alpha.id);
  await page.route("**/providers/readiness", (route) =>
    route.fulfill({ json: { ok: true, data, error: null } }),
  );
  await page.setViewportSize({ width: 1100, height: 700 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/index.html#/desktop/providers");
  const claude = page.getByRole("article", { name: "Claude", exact: true });
  await expect(
    claude.getByText("Subscription", { exact: true }).first(),
  ).toBeVisible();
  await expect(claude.getByRole("progressbar")).toHaveAttribute("value", "40");
  await expect(claude.getByText(/Reset not reported/)).toBeVisible();
  const grok = page.getByRole("article", { name: "Grok", exact: true });
  await expect(
    grok.getByText("Reporting unavailable", { exact: true }),
  ).toBeVisible();
  await expect(grok.getByRole("progressbar")).toHaveCount(0);
  await expect(
    page
      .getByRole("article", { name: "Gemini", exact: true })
      .getByText("Exhausted", { exact: true }),
  ).toBeVisible();
  await expect(
    page
      .getByRole("article", { name: "OpenRouter", exact: true })
      .getByText("Degraded", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("combobox", { name: "State", exact: true })
    .selectOption("signed-out");
  await expect(
    page.getByText("No providers match these filters", { exact: true }),
  ).toBeVisible();
  const clear = page.getByRole("button", {
    name: "Clear filters",
    exact: true,
  });
  await clear.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("article")).toHaveCount(5);
  const search = page.getByRole("searchbox", {
    name: "Find providers",
    exact: true,
  });
  await search.focus();
  expect(
    await search.evaluate((element) => getComputedStyle(element).outlineWidth),
  ).toBe("2px");
  expect(
    await search.evaluate((element) => element.getBoundingClientRect().height),
  ).toBeGreaterThanOrEqual(24);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: test.info().outputPath("providers-1100.png"),
    fullPage: true,
  });
  await page.getByRole("link", { name: "Projects", exact: true }).click();
  await expect(
    page
      .getByRole("region", { name: "Subscriptions", exact: true })
      .getByText("Fixture weekly allowance: 40% used"),
  ).toHaveCount(2);
  expect(
    await page
      .locator('.af-desktop-title-actions a[aria-label^="Providers and usage"]')
      .getAttribute("title"),
  ).toContain("Claude: Fixture weekly allowance: 40% used");
  await page.goto(`/index.html#/desktop/project/${alpha.id}/overview`);
  const usage = page.getByRole("region", {
    name: "Reported project usage",
    exact: true,
  });
  await expect(usage.getByText("12", { exact: true })).toBeVisible();
  await expect(usage.getByRole("cell", { name: "—", exact: true })).toHaveCount(
    2,
  );
});

test("loading and failed refresh keep distinct states and preserve focused check controls with last-known evidence", async ({
  page,
}) => {
  let release!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const data = providerReadinessFixture(workspace, alpha.id);
  let failed = false;
  await page.route("**/providers/readiness", async (route) => {
    await hold;
    await route.fulfill(
      failed
        ? {
            status: 503,
            json: {
              ok: false,
              data: null,
              error: "Synthetic status read failed",
            },
          }
        : { json: { ok: true, data, error: null } },
    );
  });
  await page.goto("/index.html#/desktop/providers");
  await expect(
    page.getByText("Checking providers…", { exact: true }),
  ).toBeVisible();
  release();
  await expect(
    page.getByRole("article", { name: "Claude", exact: true }),
  ).toBeVisible();
  failed = true;
  const refresh = page.getByRole("button", {
    name: "Refresh providers",
    exact: true,
  });
  await refresh.focus();
  await page.keyboard.press("Enter");
  await expect(
    page
      .getByRole("alert")
      .filter({ hasText: "Showing the last-known report" }),
  ).toBeVisible();
  await expect(refresh).toBeFocused();
  await expect(
    page.getByRole("article", { name: "Claude", exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByText("Providers could not be read", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("article")).toHaveCount(0);
});
