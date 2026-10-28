import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import baseTeardown from "../e2e/global-teardown";
import { bunPath } from "../e2e/servers";
import { fixtureEnvironment, MANIFEST, ROOT } from "./environment";

export default function teardown() {
  const manifest: unknown = JSON.parse(readFileSync(MANIFEST, "utf8"));
  if (
    !manifest ||
    typeof manifest !== "object" ||
    !("root" in manifest) ||
    typeof manifest.root !== "string" ||
    resolve(manifest.root) !== resolve(ROOT) ||
    !("owner" in manifest) ||
    typeof manifest.owner !== "string" ||
    !/^[a-f0-9-]{36}$/.test(manifest.owner)
  )
    throw new Error("Refusing cleanup of a foreign desktop owner.");
  const cleaned = spawnSync(
    bunPath(),
    [
      "scripts/hearth/desktop-entry.ts",
      "--cleanup",
      "--root",
      ROOT,
      "--owner",
      manifest.owner,
    ],
    { env: fixtureEnvironment(), encoding: "utf8", timeout: 20000 },
  );
  if (cleaned.status !== 0)
    throw new Error("The isolated desktop owner cleanup did not complete.");
  if (process.env["AGENT_FORGE_DESKTOP_RESTART_RETAIN_HOME"] !== "1")
    baseTeardown();
}
