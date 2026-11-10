import { mkdirSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";
import { openSettled, reloadSettled } from "../e2e/fixtures";
import { alpha, seedProjects } from "./project-fixtures";

test.beforeEach(seedProjects);
async function settings(page: Page) {
  await openSettled(page, "/#/desktop/app-settings");
  await expect(
    page.getByRole("heading", { name: "Appearance", exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("Theme", { exact: true })).toBeEnabled();
}
async function save(
  page: Page,
  theme: "dark" | "light" | "system",
  density: "compact" | "comfortable" = "compact",
) {
  await page.getByLabel("Theme", { exact: true }).selectOption(theme);
  await page.getByLabel("Density", { exact: true }).selectOption(density);
  await page
    .getByRole("button", { name: "Save appearance", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Save appearance", exact: true }),
  ).toBeDisabled();
  await expect(page.getByLabel("Theme", { exact: true })).toBeEnabled();
  await expect(page.locator("html")).toHaveAttribute(
    "data-af-density",
    density,
  );
}
test("appearance saves through the guarded API, survives reload and follows system changes", async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await settings(page);
  await save(page, "light", "comfortable");
  await expect(page.locator("html")).toHaveAttribute("data-af-theme", "light");
  await reloadSettled(page);
  await expect(page.getByLabel("Theme", { exact: true })).toHaveValue("light");
  await expect(page.locator("html")).toHaveAttribute(
    "data-af-density",
    "comfortable",
  );
  await save(page, "system");
  await expect(page.locator("html")).toHaveAttribute("data-af-theme", "dark");
  await page.emulateMedia({ colorScheme: "light" });
  await expect(page.locator("html")).toHaveAttribute("data-af-theme", "light");
  await expect(page.getByLabel("Theme", { exact: true })).toHaveValue("system");
  await page.setViewportSize({ width: 1100, height: 700 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  mkdirSync("test-results/appearance-evidence", { recursive: true });
  await page.screenshot({
    path: "test-results/appearance-evidence/settings-light-1100.png",
  });
  await save(page, "dark");
});
async function expectReadable(page: Page, selector: string) {
  const element = page.locator(selector).first();
  await expect(element).toBeVisible();
  const result = await element.evaluate((el) => {
    const parse = (value: string) => {
      const c = (value.match(/[\d.]+/g) ?? []).map(Number);
      return [c[0] ?? 0, c[1] ?? 0, c[2] ?? 0, c[3] ?? 1];
    };
    const blend = (front: number[], back: number[]) =>
      front
        .slice(0, 3)
        .map((c, i) => c * front[3]! + back[i]! * (1 - front[3]!));
    const ancestors: Element[] = [];
    for (
      let current: Element | null = el;
      current;
      current = current.parentElement
    )
      ancestors.unshift(current);
    let background = [255, 255, 255];
    for (const ancestor of ancestors)
      background = blend(
        parse(getComputedStyle(ancestor).backgroundColor),
        background,
      );
    const foreground = blend(parse(getComputedStyle(el).color), background);
    const luminance = (rgb: number[]) => {
      const c = rgb.map((v) => {
        const n = v / 255;
        return n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
    };
    const x = luminance(foreground),
      y = luminance(background);
    return {
      foreground,
      background,
      ratio: (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05),
    };
  });
  expect(
    result.ratio,
    `${selector}: ${JSON.stringify(result)}`,
  ).toBeGreaterThanOrEqual(4.5);
}
test("lost appearance save sends once, retains its draft and holds palette writes", async ({
  page,
}) => {
  await settings(page);
  let posts = 0;
  await page.route(
    "**/__agent-forge/app-settings/appearance",
    async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      posts++;
      await route.abort("failed");
    },
  );
  await page.getByLabel("Theme", { exact: true }).selectOption("light");
  await page
    .getByRole("button", { name: "Save appearance", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Save appearance", exact: true }),
  ).toBeDisabled();
  await page
    .getByRole("button", { name: "Check saved appearance", exact: true })
    .click();
  await expect(
    page.getByText("The earlier save is still unknown.", { exact: false }),
  ).toBeVisible();
  await expect(page.getByLabel("Theme", { exact: true })).toHaveValue("light");
  await expect(page.getByLabel("Theme", { exact: true })).toBeDisabled();
  expect(posts).toBe(1);
});
test("palette Settings navigates and Toggle theme persists through the same owner", async ({
  page,
}) => {
  await settings(page);
  await save(page, "dark");
  await openSettled(page, "/#/desktop");
  await page.keyboard.press("Control+k");
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("combobox").fill("Settings");
  await dialog
    .getByRole("option")
    .filter({ hasText: /^Settings/ })
    .click();
  await expect(
    page.getByRole("heading", { name: "Appearance", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Control+k");
  await dialog.getByRole("combobox").fill("Toggle theme");
  await expect(
    dialog.getByRole("option").filter({ hasText: "Toggle theme" }),
  ).not.toHaveAttribute("aria-disabled", "true");
  await dialog.getByRole("option").filter({ hasText: "Toggle theme" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-af-theme", "light");
  await reloadSettled(page);
  await expect(page.getByLabel("Theme", { exact: true })).toHaveValue("light");
  await save(page, "dark");
});
test("another window refreshes saved appearance without losing an unsaved draft", async ({
  page,
  context,
}) => {
  await settings(page);
  await save(page, "dark");
  const second = await context.newPage();
  await settings(second);
  await second.getByLabel("Theme", { exact: true }).selectOption("light");
  await save(page, "system");
  await second.bringToFront();
  await second
    .getByRole("button", { name: "Check saved appearance", exact: true })
    .click();
  await expect(
    second.getByText("Saved theme: system.", { exact: false }),
  ).toBeVisible();
  await expect(second.getByLabel("Theme", { exact: true })).toHaveValue(
    "light",
  );
  await second
    .getByRole("button", { name: "Save appearance", exact: true })
    .click();
  await expect(second.getByLabel("Theme", { exact: true })).toBeEnabled();
  await expect(second.locator("html")).toHaveAttribute(
    "data-af-theme",
    "light",
  );
  await second.close();
  await page.bringToFront();
  await page
    .getByRole("button", { name: "Check saved appearance", exact: true })
    .click();
  await expect(page.getByLabel("Theme", { exact: true })).toHaveValue("light");
  await save(page, "dark");
});
test("light theme retains computed text and focus contrast across desktop surfaces", async ({
  page,
}) => {
  await settings(page);
  await save(page, "light");
  await expectReadable(page, ".af-app-appearance h3");
  await expectReadable(page, ".af-app-appearance select");
  for (const route of [
    "/#/desktop",
    `/#/desktop/project/${alpha.id}/keeper`,
    `/#/desktop/project/${alpha.id}/sessions`,
    "/#/desktop/app-settings",
  ]) {
    await openSettled(page, route);
    await expect(page.locator("html")).toHaveAttribute(
      "data-af-theme",
      "light",
    );
    const ratios = await page.evaluate(() => {
      const root = document.documentElement;
      const probe = document.createElement("span");
      root.appendChild(probe);
      const rgb = (name: string) => {
        probe.style.color = `var(${name})`;
        return (getComputedStyle(probe).color.match(/[\d.]+/g) ?? [])
          .slice(0, 3)
          .map(Number)
          .map((v) => {
            const c = v / 255;
            return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
          });
      };
      const luminance = (name: string) => {
        const c = rgb(name);
        return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
      };
      const contrast = (a: string, b: string) => {
        const x = luminance(a),
          y = luminance(b);
        return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
      };
      const values = {
        text: contrast("--color-text", "--color-bg"),
        muted: contrast("--color-neutral-500", "--color-surface"),
        links: contrast("--color-accent-300", "--color-surface"),
        focus: contrast("--color-accent", "--color-surface"),
      };
      probe.remove();
      return values;
    });
    expect(ratios.text).toBeGreaterThanOrEqual(4.5);
    expect(ratios.muted).toBeGreaterThanOrEqual(4.5);
    expect(ratios.links).toBeGreaterThanOrEqual(4.5);
    expect(ratios.focus).toBeGreaterThanOrEqual(3);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await expectReadable(page, ".af-desktop-titlebar");
    await expectReadable(page, ".af-desktop-monogram");
    if (route === "/#/desktop") {
      await expectReadable(page, ".af-project-card h2 a");
      await expectReadable(page, ".af-projects-toolbar input");
      await expectReadable(page, ".af-project-keeper");
      await page
        .getByRole("button", { name: "New project", exact: true })
        .click();
      await expect(
        page.getByRole("dialog", { name: "Create a project", exact: true }),
      ).toBeVisible();
      await expectReadable(
        page,
        ".af-project-create-dialog input[aria-label='Project name']",
      );
      await page
        .getByRole("dialog", { name: "Create a project", exact: true })
        .getByRole("button", { name: "Cancel", exact: true })
        .click();
    }
    if (route.endsWith("/keeper"))
      await expectReadable(page, ".af-keeper-header");
    if (route.endsWith("/sessions"))
      await expectReadable(page, ".af-project-sessions h2");
  }
  await page.keyboard.press("Tab");
  await page
    .getByRole("button", { name: "Check saved appearance", exact: true })
    .focus();
  expect(
    await page
      .getByRole("button", { name: "Check saved appearance", exact: true })
      .evaluate((el) => el.matches(":focus-visible")),
  ).toBe(true);
  expect(
    await page
      .getByRole("button", { name: "Check saved appearance", exact: true })
      .evaluate((el) => getComputedStyle(el).outlineWidth),
  ).toBe("2px");
  await page.keyboard.press("Control+k");
  await page.getByRole("dialog").getByRole("combobox").fill("Settings");
  await expectReadable(page, ".af-command-palette [role=option].is-active");
  await page.keyboard.press("Escape");
  await save(page, "dark");
});
