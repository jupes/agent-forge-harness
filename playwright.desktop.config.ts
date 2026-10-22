import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

/** The real desktop renderer and the existing isolated hearth/CLI fixtures. */
export default defineConfig({
  ...base,
  testDir: "tests/desktop-e2e",
  projects: [
    { name: "desktop-app", use: { viewport: { width: 1440, height: 900 } } },
  ],
  webServer: (Array.isArray(base.webServer) ? base.webServer : []).map(
    (server) =>
      server.name === "dashboard"
        ? { ...server, command: `${server.command} --mode desktop` }
        : server,
  ),
});
