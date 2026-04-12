import { defineConfig, type Plugin } from "vite";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import chokidar from "chokidar";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = __dirname;
const docsRoot = path.join(repoRoot, "docs");

/**
 * Re-run build-pages when Beads JSONL exports change, then full-reload the browser.
 * Uses chokidar (not Vite's watcher) so .gitignored `.beads/*.jsonl` still triggers updates.
 */
function beadsDataReloadPlugin(): Plugin {
  return {
    name: "agent-forge-beads-data-reload",
    configureServer(server) {
      const skipInitialBuild = process.env["DASHBOARD_NO_BUILD"] === "1";

      const runBuildPages = (): boolean => {
        const r = spawnSync("bun", [path.join(repoRoot, "scripts", "build-pages.ts")], {
          cwd: repoRoot,
          stdio: "inherit",
        });
        return r.status === 0;
      };

      if (!skipInitialBuild) {
        runBuildPages();
      }

      const jsonlPaths = ["issues.jsonl", "deps.jsonl", "comments.jsonl"].map((name) =>
        path.join(repoRoot, ".beads", name),
      );

      const watcher = chokidar.watch(jsonlPaths, {
        ignoreInitial: true,
        awaitWriteFinish: { stabilityThreshold: 250, pollInterval: 50 },
      });

      const onBeadsFileChange = () => {
        if (!runBuildPages()) return;
        server.ws.send({ type: "full-reload", path: "*" });
      };

      watcher.on("add", onBeadsFileChange);
      watcher.on("change", onBeadsFileChange);
      watcher.on("unlink", onBeadsFileChange);

      server.httpServer?.on("close", () => {
        void watcher.close();
      });
    },
  };
}

export default defineConfig({
  root: docsRoot,
  /** `data/` lives under `docs/` from build-pages; no separate `public/` copy. */
  publicDir: false,
  server: {
    port: Number(process.env["PORT"] ?? "8787"),
    strictPort: false,
    host: process.env["DASHBOARD_HOST"] ?? "127.0.0.1",
  },
  plugins: [beadsDataReloadPlugin()],
});
