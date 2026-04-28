import { defineConfig, normalizePath, type Plugin, type ViteDevServer } from "vite";
import preact from "@preact/preset-vite";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import chokidar from "chokidar";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = __dirname;
const docsRoot = path.join(repoRoot, "docs");

const REBUILD_PATH = "/__agent-forge/rebuild-pages";
const PLANS_API_PREFIX = "/__agent-forge/plans-api";

/** Must match `PlanReviewIsland` / `fetchPlanRef(..., "WORKING")` — git-content disk sentinel. */
const PLANS_GIT_WORKING_REF = "WORKING";

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

type SessionContextFile = { activePlanId?: string; updatedAt?: string };

/**
 * HTTP API + file watch for harness `plans/` (drafts, committed, session-context).
 * Only active under `bun run dashboard`. Plan review page fetches these routes in dev.
 */
function plansHarnessPlugin(repoRoot: string): Plugin {
  const plansRoot = path.join(repoRoot, "plans");
  const draftsDir = path.join(plansRoot, "drafts");
  const committedDir = path.join(plansRoot, "committed");
  const sessionPath = path.join(plansRoot, "session-context.json");

  const idRe = /^[a-zA-Z0-9._-]+$/;

  function listIdsInDir(dir: string): string[] {
    try {
      if (!existsSync(dir)) return [];
      return readdirSync(dir)
        .filter((f) => f.endsWith(".md"))
        .map((f) => f.replace(/\.md$/i, ""))
        .filter((id) => idRe.test(id))
        .sort();
    } catch {
      return [];
    }
  }

  function readSessionActivePlanId(): string | null {
    if (!existsSync(sessionPath)) return null;
    try {
      const raw = readFileSync(sessionPath, "utf8");
      const j = JSON.parse(raw) as SessionContextFile;
      const id = j.activePlanId;
      if (typeof id === "string" && idRe.test(id)) return id;
    } catch {
      /* ignore */
    }
    return null;
  }

  function resolvePlanPath(bucket: "drafts" | "committed", planId: string): string | null {
    if (!idRe.test(planId)) return null;
    const baseDir = bucket === "drafts" ? draftsDir : committedDir;
    const resolved = path.normalize(path.resolve(baseDir, `${planId}.md`));
    const allowedRoot = path.normalize(path.resolve(baseDir));
    const rel = path.relative(allowedRoot, resolved);
    if (rel.startsWith(`..${path.sep}`) || rel === ".." || path.isAbsolute(rel)) return null;
    if (!existsSync(resolved)) return null;
    return resolved;
  }

  /** Path in the form `git` expects on all platforms (POSIX slashes under repo root). */
  function gitTrackedPlanRel(bucket: "drafts" | "committed", planId: string): string | null {
    if (!idRe.test(planId)) return null;
    return `plans/${bucket}/${planId}.md`;
  }

  const shaRefRe = /^[a-fA-F0-9]{7,40}$/;

  type GitPlanVersion = { sha: string; committedAt: string; subject: string };

  function isInsideGitWorkTree(root: string): boolean {
    const r = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd: root,
      encoding: "utf8",
      shell: false,
    });
    return r.status === 0 && String(r.stdout ?? "").trim() === "true";
  }

  function gitHistoryForPlan(root: string, bucket: "drafts" | "committed", planId: string): GitPlanVersion[] {
    const rel = gitTrackedPlanRel(bucket, planId);
    if (!rel) return [];
    const out = spawnSync(
      "git",
      [
        "log",
        "--all",
        "--full-history",
        "--follow",
        "--max-count=120",
        "--pretty=format:%H%n%ci%n%s%n<<<REC>>>",
        "--",
        rel,
      ],
      {
        cwd: root,
        encoding: "utf8",
        maxBuffer: 32 * 1024 * 1024,
        shell: false,
      },
    );
    if (out.status !== 0) return [];
    const raw = String(out.stdout ?? "").trim();
    if (!raw) return [];

    const chunks = raw.split("<<<REC>>>").filter((c) => c.trim());
    const versions: GitPlanVersion[] = [];
    for (const chunk of chunks) {
      const lines = chunk.trim().split("\n");
      const sha = lines[0]?.trim();
      const committedAt = lines[1]?.trim();
      const subject = lines.slice(2).join("\n").trim();
      if (!sha || !committedAt || !shaRefRe.test(sha)) continue;
      versions.push({ sha, committedAt, subject });
    }
    return versions;
  }

  function configurePlansRoutes(server: ViteDevServer): void {
    server.middlewares.use((req, res, next) => {
      const rawUrl = req.url ?? "";
      let pathname = "";
      try {
        pathname = new URL(rawUrl, "http://vite.local").pathname;
      } catch {
        pathname = rawUrl.split("?")[0] ?? "";
      }

      if (!pathname.startsWith(PLANS_API_PREFIX)) {
        next();
        return;
      }

      const sendJson = (status: number, body: unknown): void => {
        res.statusCode = status;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(JSON.stringify(body));
      };

      if (pathname === `${PLANS_API_PREFIX}/catalog`) {
        if (req.method !== "GET") {
          sendJson(405, { ok: false, error: "Method not allowed" });
          return;
        }
        const draftIds = listIdsInDir(draftsDir);
        const committedIds = listIdsInDir(committedDir);
        const ids = new Set<string>([...draftIds, ...committedIds]);
        sendJson(200, {
          ok: true,
          data: {
            draftIds,
            committedIds,
            planIds: [...ids].sort(),
            activePlanId: readSessionActivePlanId(),
          },
          error: null,
        });
        return;
      }

      if (pathname === `${PLANS_API_PREFIX}/raw`) {
        if (req.method !== "GET") {
          sendJson(405, { ok: false, error: "Method not allowed" });
          return;
        }
        let bucket = "";
        let planId = "";
        try {
          const u = new URL(rawUrl, "http://vite.local");
          bucket = u.searchParams.get("bucket") ?? "";
          planId = u.searchParams.get("id") ?? "";
        } catch {
          bucket = "";
          planId = "";
        }
        if (bucket !== "drafts" && bucket !== "committed") {
          sendJson(400, { ok: false, error: "bucket must be drafts or committed", data: null });
          return;
        }
        const abs = resolvePlanPath(bucket, planId);
        if (!abs) {
          sendJson(404, { ok: false, error: "plan file not found", data: null });
          return;
        }
        try {
          const text = readFileSync(abs, "utf8");
          res.statusCode = 200;
          res.setHeader("Content-Type", "text/plain; charset=utf-8");
          res.end(text);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          sendJson(500, { ok: false, error: msg, data: null });
        }
        return;
      }

      if (pathname === `${PLANS_API_PREFIX}/git-history`) {
        if (req.method !== "GET") {
          sendJson(405, { ok: false, error: "Method not allowed" });
          return;
        }
        let planId = "";
        let bucket = "drafts";
        try {
          const u = new URL(rawUrl, "http://vite.local");
          planId = u.searchParams.get("id") ?? "";
          const b = u.searchParams.get("bucket") ?? "drafts";
          bucket = b === "committed" ? "committed" : "drafts";
        } catch {
          planId = "";
          bucket = "drafts";
        }
        if (!idRe.test(planId)) {
          sendJson(400, { ok: false, error: "invalid plan id", data: null });
          return;
        }
        const gitOk = isInsideGitWorkTree(repoRoot);
        const versions = gitOk ? gitHistoryForPlan(repoRoot, bucket, planId) : [];
        sendJson(200, {
          ok: true,
          data: {
            bucket,
            gitAvailable: gitOk,
            versions,
          },
          error: null,
        });
        return;
      }

      if (pathname === `${PLANS_API_PREFIX}/git-content`) {
        if (req.method !== "GET") {
          sendJson(405, { ok: false, error: "Method not allowed" });
          return;
        }
        let planId = "";
        let bucket = "drafts";
        let refParam = "";
        try {
          const u = new URL(rawUrl, "http://vite.local");
          planId = u.searchParams.get("id") ?? "";
          const b = u.searchParams.get("bucket") ?? "drafts";
          bucket = b === "committed" ? "committed" : "drafts";
          refParam = u.searchParams.get("ref") ?? "";
        } catch {
          planId = "";
          bucket = "drafts";
          refParam = "";
        }
        if (!idRe.test(planId)) {
          sendJson(400, { ok: false, error: "invalid plan id", data: null });
          return;
        }
        const refUp = refParam.trim().toUpperCase();
        if (refUp === PLANS_GIT_WORKING_REF || refParam === "") {
          const abs = resolvePlanPath(bucket, planId);
          if (!abs) {
            sendJson(404, { ok: false, error: "plan file not found on disk", data: null });
            return;
          }
          try {
            const text = readFileSync(abs, "utf8");
            res.statusCode = 200;
            res.setHeader("Content-Type", "text/plain; charset=utf-8");
            res.end(text);
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            sendJson(500, { ok: false, error: msg, data: null });
          }
          return;
        }
        if (!shaRefRe.test(refParam.trim())) {
          sendJson(400, { ok: false, error: "ref must be WORKING or a git sha", data: null });
          return;
        }
        const rel = gitTrackedPlanRel(bucket, planId);
        if (!rel || !isInsideGitWorkTree(repoRoot)) {
          sendJson(503, { ok: false, error: "git history unavailable", data: null });
          return;
        }
        const spec = `${refParam.trim()}:${rel}`;
        const show = spawnSync("git", ["show", spec], {
          cwd: repoRoot,
          encoding: "utf8",
          maxBuffer: 16 * 1024 * 1024,
          shell: false,
        });
        if (show.status !== 0) {
          sendJson(404, {
            ok: false,
            error: String(show.stderr ?? show.stdout ?? "git show failed").slice(0, 800),
            data: null,
          });
          return;
        }
        res.statusCode = 200;
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.end(String(show.stdout ?? ""));
        return;
      }

      sendJson(404, { ok: false, error: "Unknown plans API route", data: null });
    });

    if (!existsSync(plansRoot)) {
      return;
    }

    let debounce: ReturnType<typeof setTimeout> | null = null;
    const scheduleReload = () => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => {
        debounce = null;
        server.ws.send({ type: "full-reload", path: "*" });
      }, 450);
    };

    const watcher = chokidar.watch(plansRoot, {
      ignoreInitial: true,
      depth: 10,
      awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
    });

    watcher.on("add", scheduleReload);
    watcher.on("change", scheduleReload);
    watcher.on("unlink", scheduleReload);

    server.httpServer?.on("close", () => {
      if (debounce) clearTimeout(debounce);
      void watcher.close();
    });
  }

  return {
    name: "agent-forge-plans-harness",
    configureServer(server) {
      configurePlansRoutes(server);
    },
  };
}

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
    plansHarnessPlugin(repoRoot),
  ],
});
