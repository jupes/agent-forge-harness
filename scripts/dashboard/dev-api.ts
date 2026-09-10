/**
 * Dev-only read APIs for the Forge run and Repos & knowledge views.
 *
 * Both pages surface state that only exists on the machine running the
 * harness — `.tmp/work/forge-state.json`, `trees/.state.json`, `repos/`,
 * `knowledge/` — none of which is committed. They follow the same shape as the
 * plans and council plugins: loopback-only, read-only, and absent from any
 * static build, where the pages show a "needs the dev server" state instead.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import type { Plugin } from "vite";
import { forgeRunSnapshot } from "./forge-run-model";
import {
  ageInDays,
  buildRepoEntries,
  type RepoEntry,
} from "./repos-knowledge-model";

export const DEV_API = "/__agent-forge/dev-api";

/** Same loopback guard the council API uses — never serve this off-machine. */
export function isLocalRequest(req: IncomingMessage): boolean {
  const remote = req.socket.remoteAddress;
  return (
    remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1"
  );
}

function readIfPresent(path: string): string | null {
  try {
    return existsSync(path) ? readFileSync(path, "utf8") : null;
  } catch {
    return null;
  }
}

function directoryNames(path: string): string[] {
  try {
    if (!existsSync(path)) return [];
    return readdirSync(path, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

/** Knowledge YAML basenames mapped to their age in days. */
export function knowledgeAges(
  knowledgeDir: string,
  now: number,
): Map<string, number | null> {
  const ages = new Map<string, number | null>();
  try {
    if (!existsSync(knowledgeDir)) return ages;
    for (const entry of readdirSync(knowledgeDir)) {
      if (!entry.endsWith(".yaml") && !entry.endsWith(".yml")) continue;
      const name = entry.replace(/\.(yaml|yml)$/i, "");
      try {
        const stats = statSync(join(knowledgeDir, entry));
        ages.set(name, ageInDays(stats.mtimeMs, now));
      } catch {
        ages.set(name, null);
      }
    }
  } catch {
    /* an unreadable knowledge dir is simply "no knowledge files" */
  }
  return ages;
}

export function readForgeRun(root: string) {
  return forgeRunSnapshot({
    stateJson: readIfPresent(join(root, ".tmp", "work", "forge-state.json")),
    worktreeJson: readIfPresent(join(root, "trees", ".state.json")),
    artifactExists: (path) => existsSync(join(root, path)),
  });
}

export function readReposKnowledge(
  root: string,
  now: number = Date.now(),
): { repos: RepoEntry[]; sharedKnowledge: string | null } {
  const sharedPath = join(root, "knowledge", "_shared.yaml");
  return {
    repos: buildRepoEntries({
      reposJson: readIfPresent(join(root, "repos", "repos.json")),
      clonedDirs: directoryNames(join(root, "repos")),
      knowledge: knowledgeAges(join(root, "knowledge", "repos"), now),
      now,
    }),
    sharedKnowledge: existsSync(sharedPath) ? "knowledge/_shared.yaml" : null,
  };
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

export function devApiPlugin(root: string): Plugin {
  return {
    name: "agent-forge-dev-api",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const pathname = (req.url ?? "").split("?")[0] ?? "";
        if (!pathname.startsWith(`${DEV_API}/`)) {
          next();
          return;
        }
        if (!isLocalRequest(req)) {
          sendJson(res, 403, {
            ok: false,
            data: null,
            error: "This API is available only from the local dashboard",
          });
          return;
        }
        if (req.method !== "GET") {
          sendJson(res, 405, {
            ok: false,
            data: null,
            error: "Method not allowed",
          });
          return;
        }

        const route = pathname.slice(DEV_API.length);
        if (route === "/forge-run") {
          sendJson(res, 200, {
            ok: true,
            data: readForgeRun(root),
            error: null,
          });
          return;
        }
        if (route === "/repos-knowledge") {
          sendJson(res, 200, {
            ok: true,
            data: readReposKnowledge(root),
            error: null,
          });
          return;
        }
        sendJson(res, 404, {
          ok: false,
          data: null,
          error: "Unknown dev API route",
        });
      });
    },
  };
}
