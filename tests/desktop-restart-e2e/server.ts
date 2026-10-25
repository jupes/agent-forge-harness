import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { startDesktopHost } from "../../scripts/hearth/desktop-host";
import { ensurePrivateHome } from "../../scripts/hearth/home-guard";
import { resolveCheckout } from "../../scripts/ledger/workspace";
import { DASHBOARD_PORT, HEARTH_HOME } from "../e2e/servers";
import { ASSETS, fixtureEnvironment, MANIFEST, ROOT } from "./environment";

ensurePrivateHome(HEARTH_HOME);
mkdirSync(resolve(ROOT, ".git"), { recursive: true });
const canonicalRoot = resolveCheckout(ROOT).workspace;
const environment = fixtureEnvironment();
for (const name of Object.keys(process.env)) delete process.env[name];
Object.assign(process.env, environment);
const build = Bun.spawn(
  [
    process.execPath,
    "run",
    "dashboard:build",
    "--mode",
    "desktop",
    "--outDir",
    ASSETS,
    "--emptyOutDir",
  ],
  {
    env: { ...process.env, DASHBOARD_NO_BUILD: "1" },
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
    timeout: 90000,
  },
);
const [code, error] = await Promise.all([
  build.exited,
  new Response(build.stderr).text(),
]);
if (code)
  throw new Error(`Isolated desktop asset build failed: ${error.slice(-4000)}`);
const host = await startDesktopHost({
  root: canonicalRoot,
  home: HEARTH_HOME,
  assetsRoot: ASSETS,
  port: DASHBOARD_PORT,
  hearthCommand: [process.execPath, resolve("scripts/hearth/server.ts")],
});
try {
  writeFileSync(
    MANIFEST,
    JSON.stringify({ root: canonicalRoot, owner: host.owner, url: host.url }),
    { mode: 0o600 },
  );
} catch (error) {
  await host.close();
  throw error;
}
console.log("Isolated desktop restart fixture ready.");
let closing = false;
const close = () => {
  if (closing) return;
  closing = true;
  void host.close().finally(() => process.exit(0));
};
process.once("SIGTERM", close);
process.once("SIGINT", close);
