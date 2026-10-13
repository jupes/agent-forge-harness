import { defineConfig, normalizePath } from "vite";
import preact from "@preact/preset-vite";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { rebuildPagesPlugin } from "./scripts/dashboard/rebuild-pages";
import { hearthPlugin } from "./scripts/hearth/vite-plugin";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = __dirname;
const docsRoot = path.join(repoRoot, "docs");

export default defineConfig({
  root: docsRoot,
  /** `data/` lives under `docs/` from build-pages; no separate `public/` copy. */
  publicDir: false,
  resolve: {
    alias: {
      // normalizePath: Windows backslashes in path.join can confuse Vite's import resolver.
      "@docs/bead-builder": normalizePath(path.join(docsRoot, "js", "bead-builder.mjs")),
      "@docs/skill-builder": normalizePath(path.join(docsRoot, "js", "skill-builder.mjs")),
    },
  },
  build: {
    rollupOptions: {
      // Both documents, or `vite build` silently emits only index.html and
      // council.html is never verified by a build at all.
      input: {
        index: path.join(docsRoot, "index.html"),
        council: path.join(docsRoot, "council.html"),
      },
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
    // POST /__agent-forge/rebuild-pages (Refresh snapshot), the first build and
    // rebuilds on `.beads/` changes: a child process, one at a time, off the
    // server's thread. Registered before the hearth so the proxy never sees it.
    rebuildPagesPlugin({
      root: repoRoot,
      initialBuild: process.env["DASHBOARD_NO_BUILD"] !== "1",
    }),
    hearthPlugin(repoRoot),
  ],
});
