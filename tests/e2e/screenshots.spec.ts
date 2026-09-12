import { expect, type Page, test } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { stubForgeRun, stubRepos } from "./fixtures";

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

interface Surface {
  name: string;
  url: string;
  /** Serve fixture state instead of this machine's local files. */
  stub?: (page: Page) => Promise<unknown>;
}

const SURFACES: Surface[] = [
  { name: "dashboard", url: "/index.html#/dashboard" },
  { name: "issues", url: "/index.html#/issues" },
  { name: "epics", url: "/index.html#/epics" },
  { name: "commands", url: "/index.html#/commands" },
  { name: "bead-builder", url: "/index.html#/bead-builder" },
  { name: "insights", url: "/index.html#/insights" },
  // These two render machine-local state. The committed images must not show a
  // real home directory or someone's cloned repositories, so they use fixtures.
  { name: "forge-run", url: "/index.html#/forge-run", stub: stubForgeRun },
  { name: "repos", url: "/index.html#/repos", stub: (page) => stubRepos(page) },
  { name: "plan-review", url: "/plan-review.html" },
  { name: "council", url: "/council.html" },
];

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

      await surface.stub?.(page);
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
