import { expect, test } from "@playwright/test";
import { collectErrors, ROUTES } from "./routes";

/**
 * Accessibility and responsive behavior.
 *
 * Everything here is invisible to the vnode tests in `scripts/`: computed
 * outlines, real focus order, layout at a viewport, and whether an element is
 * actually reachable.
 */

test("keyboard focus produces a visible outline, not a suppressed one", async ({
  page,
}) => {
  await page.goto("/index.html#/dashboard", { waitUntil: "networkidle" });

  await page.keyboard.press("Tab");

  const focus = await page.evaluate(() => {
    const el = document.activeElement;
    if (!el || el === document.body) return null;
    const style = getComputedStyle(el);
    return {
      tag: el.tagName.toLowerCase(),
      outlineStyle: style.outlineStyle,
      outlineWidth: Number.parseFloat(style.outlineWidth),
    };
  });

  expect(focus, "something should receive focus on the first Tab").not.toBeNull();
  expect(focus?.outlineStyle).not.toBe("none");
  expect(focus?.outlineWidth ?? 0).toBeGreaterThan(0);
});

test("the skip link moves focus to main without changing the route", async ({
  page,
}) => {
  // Start somewhere other than the default route: a skip link that navigates
  // would land on Dashboard, which a test starting there could not notice.
  await page.goto("/index.html#/issues", { waitUntil: "networkidle" });

  await page.keyboard.press("Tab");
  const skip = page.locator(".af-skip-link");
  await expect(skip).toBeFocused();
  await expect(skip).toHaveText(/Skip to content/);

  await page.keyboard.press("Enter");

  await expect(page).toHaveURL(/#\/issues$/);
  await expect(page.locator("h1")).toHaveText("All issues");
  await expect(page.locator("main#af-main")).toBeFocused();
});

test("a bare in-page fragment does not reset the current route", async ({
  page,
}) => {
  await page.goto("/index.html#/epics", { waitUntil: "networkidle" });
  await page.evaluate(() => {
    window.location.hash = "af-main";
  });
  await expect(page.locator("h1")).toHaveText("Epics");
});

test("every nav destination is reachable by keyboard alone", async ({
  page,
}) => {
  await page.goto("/index.html#/dashboard", { waitUntil: "networkidle" });

  const reached = new Set<string>();
  for (let i = 0; i < 40; i += 1) {
    await page.keyboard.press("Tab");
    const href = await page.evaluate(() => {
      const el = document.activeElement as HTMLAnchorElement | null;
      return el?.classList.contains("af-nav-item") ? el.getAttribute("href") : null;
    });
    if (href) reached.add(href);
    if (reached.size >= ROUTES.length) break;
  }

  expect(reached.size).toBe(ROUTES.length);
});

/** Open the Bead builder's dialog from its submit button. */
async function openBeadDialog(page: import("@playwright/test").Page) {
  await page.goto("/index.html#/bead-builder", { waitUntil: "networkidle" });
  await page.fill("#bb-title", "Keyboard check");
  const submit = page.locator("button[type=submit]");
  await submit.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  return { dialog, submit };
}

test("the builder dialog is labelled by its own heading", async ({ page }) => {
  const { dialog } = await openBeadDialog(page);
  const labelledBy = await dialog.getAttribute("aria-labelledby");
  expect(labelledBy).toBeTruthy();
  await expect(page.locator(`#${labelledBy}`)).toBeVisible();
});

test("Tab and Shift+Tab stay inside an open dialog", async ({ page }) => {
  const { dialog } = await openBeadDialog(page);

  const focusInsideDialog = () =>
    page.evaluate(
      () => document.activeElement?.closest("dialog[open]") !== null,
    );

  // Initial focus lands inside, not on the page behind.
  expect(await focusInsideDialog()).toBe(true);

  // More presses than the dialog has focusable elements, in both directions,
  // so a leak into the shell behind it would have to show up.
  for (let i = 0; i < 12; i += 1) {
    await page.keyboard.press("Tab");
    expect(await focusInsideDialog(), `Tab #${i + 1} left the dialog`).toBe(
      true,
    );
  }
  for (let i = 0; i < 12; i += 1) {
    await page.keyboard.press("Shift+Tab");
    expect(
      await focusInsideDialog(),
      `Shift+Tab #${i + 1} left the dialog`,
    ).toBe(true);
  }

  await expect(dialog).toBeVisible();
});

test("the page behind an open dialog is inert", async ({ page }) => {
  await openBeadDialog(page);
  const navReachable = await page.evaluate(() => {
    const link = document.querySelector<HTMLElement>("nav a.af-nav-item");
    link?.focus();
    return document.activeElement === link;
  });
  expect(navReachable).toBe(false);
});

test("Escape closes the dialog and returns focus to the control that opened it", async ({
  page,
}) => {
  const { dialog, submit } = await openBeadDialog(page);

  await page.keyboard.press("Escape");

  await expect(dialog).toBeHidden();
  await expect(submit).toBeFocused();
});

test("issue rows are operable with the keyboard", async ({ page }) => {
  await page.goto("/index.html#/issues", { waitUntil: "networkidle" });

  const row = page.locator(".af-issue-row").first();
  const rowCount = await page.locator(".af-issue-row").count();
  test.skip(rowCount === 0, "no snapshot data available in this checkout");

  await expect(row).toHaveAttribute("role", "button");
  await row.focus();
  await expect(row).toHaveAttribute("aria-expanded", "false");
  await page.keyboard.press("Enter");
  await expect(row).toHaveAttribute("aria-expanded", "true");
});

test.describe("mobile viewport", () => {
  test.skip(
    ({ viewport }) => (viewport?.width ?? 0) > 500,
    "mobile-only expectations",
  );

  test("the nav stays reachable instead of being display:none", async ({
    page,
  }) => {
    await page.goto("/index.html#/dashboard", { waitUntil: "networkidle" });

    const nav = page.locator("nav.af-nav");
    await expect(nav).toBeVisible();
    await expect(nav).not.toHaveCSS("display", "none");

    // Every destination is still present and clickable, not hidden away.
    await expect(page.locator("nav a.af-nav-item").first()).toBeVisible();
    await page.locator("nav a.af-nav-item", { hasText: "Commands" }).click();
    await expect(page.locator("h1")).toHaveText("Commands");
  });

  test("no page scrolls sideways at 375px", async ({ page }) => {
    for (const route of ROUTES) {
      const errors = collectErrors(page);
      await page.goto(route.url, { waitUntil: "networkidle" });
      const overflow = await page.evaluate(
        () =>
          document.documentElement.scrollWidth -
          document.documentElement.clientWidth,
      );
      expect(overflow, `${route.url} overflows horizontally`).toBeLessThanOrEqual(1);
      expect(errors, `errors on ${route.url}`).toEqual([]);
    }
  });
});
