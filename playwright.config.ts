import { defineConfig, devices } from "@playwright/test";

/**
 * Browser verification for the dashboard.
 *
 * Exists because the vnode tests in `scripts/` assert structure and cannot see
 * computed styles, focus rings, layout at a viewport, or runtime console
 * errors. Anything in that category is verified here instead.
 *
 * Run with `bun run verify:ui`. The dev server is started for you.
 */

const PORT = Number(process.env["PORT"] ?? 8799);

export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: false,
  workers: 1,
  reporter: process.env["CI"] ? "line" : [["list"]],
  timeout: 45_000,
  expect: { timeout: 10_000 },

  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: "retain-on-failure",
  },

  projects: [
    {
      name: "desktop",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 900 } },
    },
    {
      name: "mobile",
      use: { ...devices["Desktop Chrome"], viewport: { width: 375, height: 812 } },
    },
  ],

  webServer: {
    // DASHBOARD_NO_BUILD keeps the suite from regenerating the Beads snapshot
    // on every run; whatever docs/data/beads.json holds is what gets rendered.
    command: "bun run dashboard",
    env: { PORT: String(PORT), DASHBOARD_NO_BUILD: "1" },
    url: `http://127.0.0.1:${PORT}/index.html`,
    reuseExistingServer: !process.env["CI"],
    timeout: 120_000,
    stdout: "ignore",
    stderr: "pipe",
  },
});
