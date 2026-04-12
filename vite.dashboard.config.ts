import { defineConfig, type Plugin } from "vite";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import chokidar from "chokidar";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = __dirname;
const docsRoot = path.join(repoRoot, "docs");

/**
 * Re-run build-pages when Beads data changes, then full-reload the browser.
 * Watches `.beads/` (Dolt + JSONL) with chokidar so .gitignored paths still trigger updates;
 * debounced to avoid rebuild storms from Dolt internals.
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

      const beadsDir = path.join(repoRoot, ".beads");
      if (!existsSync(beadsDir)) {
        return;
      }

      const watcher = chokidar.watch(beadsDir, {
        ignoreInitial: true,
        depth: 10,
        awaitWriteFinish: { stabilityThreshold: 400, pollInterval: 100 },
        ignored: [
          "**/dolt-server.log",
          "**/dolt-server.pid",
          "**/dolt-server.port",
          "**/bd.sock*",
          "**/.exclusive-lock",
          "**/sync-state.json",
          "**/push-state.json",
          "**/interactions.jsonl",
          "**/last-touched",
        ],
      });

      const onBeadsFileChange = () => {
        if (!runBuildPages()) return;
        server.ws.send({ type: "full-reload", path: "*" });
      };

      let debounce: ReturnType<typeof setTimeout> | null = null;
      const schedule = () => {
        if (debounce) clearTimeout(debounce);
        debounce = setTimeout(() => {
          debounce = null;
          onBeadsFileChange();
        }, 700);
      };

      watcher.on("add", schedule);
      watcher.on("change", schedule);
      watcher.on("unlink", schedule);

      server.httpServer?.on("close", () => {
        if (debounce) clearTimeout(debounce);
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
