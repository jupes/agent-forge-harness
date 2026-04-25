import { defineConfig, type Plugin } from "vite";
import preact from "@preact/preset-vite";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import chokidar from "chokidar";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = __dirname;
const docsRoot = path.join(repoRoot, "docs");

const REBUILD_PATH = "/__agent-forge/rebuild-pages";

/**
 * POST {REBUILD_PATH} — run `scripts/build-pages.ts` (same as `bun run build-pages`).
 * Used by the dashboard nav button; only active under `bun run dashboard` (Vite dev).
 */
function rebuildPagesApiPlugin(): Plugin {
  return {
    name: "agent-forge-rebuild-pages-api",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const pathname = (req.url ?? "").split("?")[0] ?? "";
        if (pathname !== REBUILD_PATH) {
          next();
          return;
        }
        if (req.method !== "POST") {
          res.statusCode = 405;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ ok: false, error: "Method not allowed — use POST" }));
          return;
        }
        const r = spawnSync("bun", [path.join(repoRoot, "scripts", "build-pages.ts")], {
          cwd: repoRoot,
          encoding: "utf8",
          maxBuffer: 16 * 1024 * 1024,
        });
        res.setHeader("Content-Type", "application/json");
        if (r.status !== 0) {
          res.statusCode = 500;
          const err = (r.stderr || r.stdout || `build-pages exited with status ${r.status}`).slice(0, 8000);
          res.end(JSON.stringify({ ok: false, error: err }));
          return;
        }
        res.statusCode = 200;
        res.end(JSON.stringify({ ok: true }));
      });
    },
  };
}

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
  resolve: {
    alias: {
      "@docs/bead-builder": path.join(docsRoot, "js", "bead-builder.mjs"),
      "@docs/skill-builder": path.join(docsRoot, "js", "skill-builder.mjs"),
    },
  },
  server: {
    port: Number(process.env["PORT"] ?? "8787"),
    strictPort: false,
    host: process.env["DASHBOARD_HOST"] ?? "127.0.0.1",
  },
  plugins: [
    preact({
      // Preset's transform-hook-names does `import("zimmerframe")` in the Node/Vite
      // process; Vite aliases do not apply there. zimmerframe's exports lack "default",
      // which breaks Bun (ERR_PACKAGE_PATH_NOT_EXPORTED). Disabling only hook-name
      // labeling — preact/debug still injects in dev. See sveltejs/zimmerframe#34.
      devToolsEnabled: false,
    }),
    rebuildPagesApiPlugin(),
    beadsDataReloadPlugin(),
  ],
});
