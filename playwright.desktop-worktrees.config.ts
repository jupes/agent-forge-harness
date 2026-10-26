import "./tests/desktop-worktree-e2e/environment";
import { defineConfig } from "@playwright/test";
import base from "./playwright.desktop.config";
import {
  FIXTURE_ROOT,
  OS_HOME,
  prepareRepository,
  REPOSITORY,
} from "./tests/desktop-worktree-e2e/environment";
import { bunPath } from "./tests/e2e/servers";

prepareRepository();
export default defineConfig({
  ...base,
  testDir: "tests/desktop-worktree-e2e",
  outputDir: "test-results-desktop-worktrees",
  globalSetup: "./tests/desktop-worktree-e2e/setup.ts",
  globalTeardown: "./tests/desktop-worktree-e2e/teardown.ts",
  timeout: 60_000,
  webServer: (Array.isArray(base.webServer) ? base.webServer : []).map(
    (server) => ({
      ...server,
      command:
        server.name === "hearth"
          ? `${server.command} --root "${REPOSITORY}"`
          : `"${bunPath()}" node_modules/vite/bin/vite.js --config tests/desktop-worktree-e2e/vite.config.ts --strictPort --mode desktop`,
      env: {
        ...server.env,
        AGENT_FORGE_WORKTREE_FIXTURE_ROOT: FIXTURE_ROOT,
        AGENT_FORGE_WORKTREE_OS_HOME: OS_HOME,
        HOME: OS_HOME,
        USERPROFILE: OS_HOME,
      },
    }),
  ),
});
