import { defineConfig } from "@playwright/test";
import base from "./playwright.config";
import {
  bunPath,
  DASHBOARD_PORT,
  DASHBOARD_URL,
  dashboardPathDirectories,
  HEARTH_HOME,
  HEARTH_PORT,
  NODE_DIR,
  standInEnvironment,
} from "./tests/e2e/servers";

export default defineConfig({
  ...base,
  testDir: "tests/desktop-restart-e2e",
  outputDir: "test-results-desktop-restart",
  globalSetup: "./tests/desktop-restart-e2e/setup.ts",
  globalTeardown: "./tests/desktop-restart-e2e/teardown.ts",
  projects: [
    {
      name: "desktop-owned-restart",
      use: { viewport: { width: 1100, height: 700 } },
    },
  ],
  webServer: [
    {
      name: "owned-desktop-host",
      command: `"${bunPath()}" tests/desktop-restart-e2e/server.ts`,
      env: {
        ...standInEnvironment(dashboardPathDirectories(process.cwd())),
        PORT: String(DASHBOARD_PORT),
        HEARTH_PORT: String(HEARTH_PORT),
        E2E_HEARTH_PORT: String(HEARTH_PORT),
        DESKTOP_RESTART_NODE_DIR: NODE_DIR,
        AGENT_FORGE_HOME: HEARTH_HOME,
      },
      url: DASHBOARD_URL,
      reuseExistingServer: false,
      timeout: 120000,
      stdout: "pipe",
      stderr: "pipe",
    },
  ],
});
