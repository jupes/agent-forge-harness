import { realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { projectFixture } from "../../scripts/projects/testing";
import {
  BD_STAND_IN_STATE,
  bunPath,
  findBd,
  HEARTH_HOME,
  isRunHome,
  NODE_DIR,
  standInEnvironment,
} from "../e2e/servers";

if (!isRunHome(HEARTH_HOME))
  throw new Error("Restart E2E requires its own generated OS-temp home.");
// Canonicalize the existing parent before the fixture exists, so config,
// setup, server and workers agree even when Windows tmpdir uses an 8.3 alias.
const requestedRoot = join(
  realpathSync.native(dirname(HEARTH_HOME)),
  basename(HEARTH_HOME),
  "repository",
);
export const ROOT =
  process.platform === "win32"
    ? requestedRoot.replaceAll("\\", "/").toLowerCase()
    : requestedRoot;
export const ASSETS = join(HEARTH_HOME, "desktop-assets");
export const MANIFEST = join(HEARTH_HOME, "restart-fixture.json");
export const alpha = projectFixture(ROOT);

/** No ambient provider keys, proxy settings, config home or real command directories. */
export function fixtureEnvironment(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env))
    if (
      value !== undefined &&
      /^(SystemRoot|SystemDrive|WINDIR|COMSPEC|PATHEXT|TEMP|TMP|LANG|LC_ALL)$/i.test(
        name,
      )
    )
      env[name] = value;
  const directories = [
    dirname(typeof Bun === "undefined" ? bunPath() : process.execPath),
    process.env["DESKTOP_RESTART_NODE_DIR"] ?? NODE_DIR,
  ];
  if (findBd(directories))
    throw new Error("A real bd is reachable beside the fixture runtime.");
  Object.assign(env, standInEnvironment(directories), {
    HOME: join(HEARTH_HOME, "user"),
    USERPROFILE: join(HEARTH_HOME, "user"),
    APPDATA: join(HEARTH_HOME, "user", "AppData", "Roaming"),
    LOCALAPPDATA: join(HEARTH_HOME, "user", "AppData", "Local"),
    XDG_CONFIG_HOME: join(HEARTH_HOME, "user", "config"),
    AGENT_FORGE_HOME: HEARTH_HOME,
    AGENT_FORGE_E2E_HOME: HEARTH_HOME,
    BD_STAND_IN_STATE,
    HEARTH_PORT: process.env["E2E_HEARTH_PORT"] ?? "8798",
    NO_PROXY: "127.0.0.1,localhost",
    no_proxy: "127.0.0.1,localhost",
    DESKTOP_RESTART_NODE_DIR:
      process.env["DESKTOP_RESTART_NODE_DIR"] ?? NODE_DIR,
  });
  return env;
}
