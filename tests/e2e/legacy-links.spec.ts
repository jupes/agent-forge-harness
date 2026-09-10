import { expect, test } from "@playwright/test";

/**
 * The URL shapes that existed before the router.
 *
 * These may sit in bookmarks, in other pages' markup, or in links an agent
 * generated, so they have to keep resolving.
 */

const LEGACY_VIEWS: [string, string][] = [
  ["dashboard", "Dashboard"],
  ["list", "All issues"],
  ["epics", "Epics"],
  ["commands", "Commands"],
  ["skill-builder", "Skill builder"],
  ["bead-builder", "Bead builder"],
  ["insights", "Insights"],
];

test.describe("legacy ?view= links", () => {
  for (const [view, heading] of LEGACY_VIEWS) {
    test(`?view=${view} still lands on ${heading}`, async ({ page }) => {
      await page.goto(`/index.html?view=${view}`, {
        waitUntil: "networkidle",
      });
      await expect(page.locator("h1")).toHaveText(heading);
      // The consumed query is dropped rather than left beside its replacement.
      expect(page.url()).not.toContain("view=");
      expect(page.url()).toContain("#/");
    });
  }

  test("an unknown ?view= value is ignored rather than redirected somewhere wrong", async ({
    page,
  }) => {
    await page.goto("/index.html?view=nope", { waitUntil: "networkidle" });
    await expect(page.locator("h1")).toHaveText("Dashboard");
  });
});

test("council.html?sourceType=plan&source=… still prefills the setup form", async ({
  page,
}) => {
  const source = "plans/drafts/example.md";
  await page.goto(
    `/council.html?sourceType=plan&source=${encodeURIComponent(source)}`,
    { waitUntil: "networkidle" },
  );

  await expect(page.locator("#council-source-type")).toHaveValue("plan");
  await expect(page.locator("#council-source")).toHaveValue(source);
});

test("plan review builds a council link pointing at the selected plan", async ({
  page,
}) => {
  await page.goto("/plan-review.html", { waitUntil: "networkidle" });

  const link = page.locator("a", { hasText: "Send to council" });
  const count = await link.count();
  test.skip(count === 0, "no plans available in this checkout");

  const href = await link.first().getAttribute("href");
  expect(href).toMatch(/^council\.html\?/);
  expect(href).toContain("sourceType=plan");
  expect(href).toMatch(/source=plans(%2F|\/)(drafts|committed)/);
});

test("council.html?run=<id> is a real bookmark", async ({ page }) => {
  // An id that does not exist must fail gracefully rather than break the page.
  await page.goto("/council.html?run=does-not-exist", {
    waitUntil: "networkidle",
  });
  await expect(page.locator("h1")).toHaveText("Council review");
  await expect(page.locator("nav a.af-nav-item")).toHaveCount(11);
});
