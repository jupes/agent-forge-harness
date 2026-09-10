import { expect, test } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Capture the principal surfaces.
 *
 * Run against this branch and against origin/master with the same spec so the
 * before/after pair is framed identically:
 *
 *   SHOT_DIR=.tmp/shots/after bun run verify:ui -- --grep @screenshot
 *
 * Tagged so the normal suite does not write files.
 */

const SURFACES = [
  { name: "dashboard", url: "/index.html#/dashboard" },
  { name: "issues", url: "/index.html#/issues" },
  { name: "epics", url: "/index.html#/epics" },
  { name: "commands", url: "/index.html#/commands" },
  { name: "bead-builder", url: "/index.html#/bead-builder" },
  { name: "insights", url: "/index.html#/insights" },
  { name: "forge-run", url: "/index.html#/forge-run" },
  { name: "repos", url: "/index.html#/repos" },
  { name: "plan-review", url: "/plan-review.html" },
  { name: "council", url: "/council.html" },
] as const;

const OUT = process.env["SHOT_DIR"] ?? ".tmp/shots";

test.describe("@screenshot", () => {
  test.skip(
    () => process.env["SHOT_DIR"] === undefined,
    "set SHOT_DIR to capture screenshots",
  );

  for (const surface of SURFACES) {
    test(`capture ${surface.name}`, async ({ page }, testInfo) => {
      const dir = join(OUT, testInfo.project.name);
      mkdirSync(dir, { recursive: true });

      await page.goto(surface.url, { waitUntil: "networkidle" });
      // Charts and polling views need a beat to settle before capture.
      await page.waitForTimeout(1200);

      await page.screenshot({
        path: join(dir, `${surface.name}.png`),
        fullPage: true,
      });

      await expect(page.locator("h1")).toBeVisible();
    });
  }
});
