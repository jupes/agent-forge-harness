import { expect, test } from "@playwright/test";
import { openSettled } from "./fixtures";
import { collectErrors, NAV_DESTINATION_COUNT, ROUTES } from "./routes";

test.describe("every route loads by direct navigation", () => {
  for (const route of ROUTES) {
    test(`${route.url} renders "${route.heading}" cleanly`, async ({
      page,
    }) => {
      const errors = collectErrors(page);

      await openSettled(page, route.url);

      await expect(page.locator("h1")).toHaveText(route.heading);

      // The shell, including its global actions, is present on every page —
      // council.html used to ship a reduced nav with none of this.
      await expect(page.locator("nav a.af-nav-item")).toHaveCount(
        NAV_DESTINATION_COUNT,
      );
      await expect(page.locator("nav a[aria-current='page']")).toHaveCount(1);
      await expect(page.locator(".af-shell-refresh")).toHaveCount(1);
      await expect(page.locator(".af-shell-snapshot")).toHaveCount(1);
      await expect(page.locator("#copy-toast")).toHaveCount(1);

      expect(errors, `errors on ${route.url}`).toEqual([]);
    });
  }
});

test("the self-hosted typeface loads with no request to a font CDN", async ({
  page,
}) => {
  const external: string[] = [];
  page.on("request", (request) => {
    const url = request.url();
    if (/fonts\.(googleapis|gstatic)\.com|unpkg\.com|cdnjs/.test(url)) {
      external.push(url);
    }
  });

  await openSettled(page, "/index.html#/dashboard");

  expect(external).toEqual([]);
  await expect(page.locator("body")).toHaveCSS(
    "font-family",
    /Inter|system-ui/,
  );
});

test("the active nav item is the one matching the current route", async ({
  page,
}) => {
  await openSettled(page, "/index.html#/issues");
  await expect(page.locator("nav a[aria-current='page']")).toHaveText(
    /All issues/,
  );

  await openSettled(page, "/council.html");
  await expect(page.locator("nav a[aria-current='page']")).toHaveText(
    /Council/,
  );
});

test("a data-independent route still paints when the snapshot fetch fails", async ({
  page,
}) => {
  // The bug this rewrite was scoped around. Intercepted rather than deleting
  // docs/data/beads.json, which is live generated data.
  await page.route("**/data/beads.json", (route) =>
    route.fulfill({ status: 404, body: "not found" }),
  );

  await openSettled(page, "/index.html#/commands");

  await expect(page.locator("h1")).toHaveText("Commands");
  await expect(page.locator("table").first()).toBeVisible();
});

test("an issue view explains itself when the snapshot is unavailable", async ({
  page,
}) => {
  await page.route("**/data/beads.json", (route) =>
    route.fulfill({ status: 404, body: "not found" }),
  );

  await openSettled(page, "/index.html#/dashboard");

  await expect(page.locator(".af-empty")).toContainText("No snapshot loaded");
  await expect(page.locator(".af-empty")).toContainText("bun run build-pages");
});

test("an unknown route falls back to the dashboard rather than a blank page", async ({
  page,
}) => {
  await openSettled(page, "/index.html#/does-not-exist");
  await expect(page.locator("h1")).toHaveText("Dashboard");
});
