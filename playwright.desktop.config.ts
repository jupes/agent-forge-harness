import { defineConfig } from "@playwright/test";
import base from "./playwright.config";
import { repositoryFixtureEnvironment } from "./tests/e2e/servers";

/** The real desktop renderer and the existing isolated hearth/CLI fixtures. */
export default defineConfig({
  ...base,
  testDir: "tests/desktop-e2e",
  globalSetup: "./tests/desktop-e2e/global-setup.ts",
  projects: [
    { name: "desktop-app", use: { viewport: { width: 1440, height: 900 } } },
  ],
  webServer: (Array.isArray(base.webServer) ? base.webServer : []).map(
    (server) =>
      server.name === "hearth"
        ? {
            ...server,
            env: {
              ...(server.env ?? {}),
              ...repositoryFixtureEnvironment(),
            },
            command: server.command.replace(
              "scripts/hearth/server.ts",
              "tests/desktop-e2e/hearth-server.ts",
            ),
          }
        : server.name === "dashboard"
          ? { ...server, command: `${server.command} --mode desktop` }
          : server,
  ),
});
