import { defineConfig, devices } from "@playwright/test";
import { HEALTH_ROUTE } from "./scripts/hearth/paths";
import {
  DASHBOARD_PORT,
  DASHBOARD_URL,
  HEARTH_HOME,
  HEARTH_PORT,
  HEARTH_URL,
} from "./tests/e2e/servers";

/**
 * Browser verification for the dashboard.
 *
 * Exists because the vnode tests in `scripts/` assert structure and cannot see
 * computed styles, focus rings, layout at a viewport, or runtime console
 * errors. Anything in that category is verified here instead.
 *
 * Run with `bun run verify:ui`. The hearth and the dashboard are started for
 * you, and stopped afterwards.
 */

const CI = Boolean(process.env["CI"]);

/**
 * What a normal run leaves out, so that "skipped" only ever means something
 * went wrong. Captures write files and run when SHOT_DIR asks for them;
 * `@mobile` tests assert a 375px layout and run on the mobile project.
 *
 * A project's `grepInvert` replaces a top-level one rather than adding to it,
 * so each project names everything it deselects.
 */
const CAPTURES = process.env["SHOT_DIR"] === undefined ? [/@screenshot/] : [];

export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: false,
  workers: 1,
  // A stray `test.only` would let the CI job pass on a single test.
  forbidOnly: CI,
  // A broken suite burns a timeout per test; stop early so the job still has
  // time to upload its traces.
  maxFailures: CI ? 10 : 0,
  // `list` in CI too: the log names every test that ran.
  reporter: "list",
  timeout: 45_000,
  expect: { timeout: 10_000 },
  globalTeardown: "./tests/e2e/global-teardown.ts",

  use: {
    baseURL: DASHBOARD_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },

  projects: [
    {
      name: "desktop",
      grepInvert: [...CAPTURES, /@mobile/],
      use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 900 } },
    },
    {
      name: "mobile",
      grepInvert: CAPTURES,
      use: { ...devices["Desktop Chrome"], viewport: { width: 375, height: 812 } },
    },
  ],

  // Started in order, each awaited. A server already answering on either port
  // is an error rather than something to attach to: it may belong to another
  // checkout, or to a hearth in the developer's real home. Override `PORT` or
  // `E2E_HEARTH_PORT` to run beside one.
  webServer: [
    {
      // The control plane first, so its readiness is checked on its own and its
      // output reaches this log. The dashboard attaches to it; left to itself
      // the dashboard would spawn one and discard what it prints.
      name: "hearth",
      // Not `bun run hearth`: see scripts/hearth/AGENTS.md.
      command: "bun scripts/hearth/server.ts",
      env: {
        HEARTH_PORT: String(HEARTH_PORT),
        AGENT_FORGE_HOME: HEARTH_HOME,
      },
      url: `${HEARTH_URL}${HEALTH_ROUTE}`,
      reuseExistingServer: false,
      timeout: 60_000,
      stdout: "pipe",
      stderr: "pipe",
    },
    {
      name: "dashboard",
      // --strictPort: a taken port is an error, not a silent move to the next
      // one while this config waits on the old one.
      command: "bun run dashboard --strictPort",
      env: {
        PORT: String(DASHBOARD_PORT),
        // Keeps the suite from regenerating the Beads snapshot on every run;
        // whatever docs/data/beads.json holds is what gets rendered.
        DASHBOARD_NO_BUILD: "1",
        AGENT_FORGE_HOME: HEARTH_HOME,
      },
      url: `${DASHBOARD_URL}/index.html`,
      reuseExistingServer: false,
      timeout: 120_000,
      stdout: "ignore",
      stderr: "pipe",
    },
  ],
});
