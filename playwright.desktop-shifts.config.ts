import "./tests/desktop-shift-e2e/environment";
import { delimiter, join } from "node:path";
import { defineConfig } from "@playwright/test";
import base from "./playwright.desktop.config";
import { buildChildEnv } from "./scripts/executors/env";
import {
  BIN,
  EMPTY_HOME,
  FIXTURE_ROOT,
  HOME,
  prepareFixture,
  REPOSITORY,
  STATE,
} from "./tests/desktop-shift-e2e/environment";
import { bunPath, NODE_DIR } from "./tests/e2e/servers";

prepareFixture(bunPath());
const system = Object.fromEntries(
  Object.entries(buildChildEnv(process.env, [])).filter(
    ([key]) => key.toLowerCase() !== "path",
  ),
);
export default defineConfig({
  ...base,
  testDir: "tests/desktop-shift-e2e",
  outputDir: "test-results/desktop-shifts",
  globalSetup: "./tests/desktop-shift-e2e/setup.ts",
  globalTeardown: "./tests/desktop-shift-e2e/teardown.ts",
  timeout: 60000,
  webServer: (Array.isArray(base.webServer) ? base.webServer : []).map(
    (server) => ({
      ...server,
      command:
        server.name === "hearth"
          ? `"${bunPath()}" scripts/hearth/server.ts --root "${REPOSITORY}"`
          : `"${bunPath()}" node_modules/vite/bin/vite.js --config tests/desktop-shift-e2e/vite.config.ts --strictPort --mode desktop`,
      env: {
        ...system,
        PORT: process.env["PORT"] ?? "8989",
        HEARTH_PORT: process.env["E2E_HEARTH_PORT"] ?? "8988",
        AGENT_FORGE_HOME: HOME,
        AGENT_FORGE_SHIFT_FIXTURE_ROOT: FIXTURE_ROOT,
        HOME: EMPTY_HOME,
        USERPROFILE: EMPTY_HOME,
        APPDATA: EMPTY_HOME,
        LOCALAPPDATA: EMPTY_HOME,
        PATH: [BIN, ...(server.name === "dashboard" ? [NODE_DIR] : [])].join(
          delimiter,
        ),
        DASHBOARD_NO_BUILD: "1",
        CODING_FIXTURE_RECORD: join(STATE, "claude.json"),
        CODEX_RUNTIME_LOG: join(STATE, "codex.jsonl"),
      },
    }),
  ),
});
