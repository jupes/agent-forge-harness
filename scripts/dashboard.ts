#!/usr/bin/env bun
/**
 * Build dashboard data from Beads JSONL (when present), then serve docs/ over HTTP.
 *
 * Usage:
 *   bun run dashboard              # build-pages + static server
 *   bun run dashboard -- --no-build   # serve only (skip build-pages)
 *   PORT=9000 bun run dashboard
 *
 * Why Bun.serve instead of Vite/Python: zero extra install for anyone who already
 * uses this repo with Bun; fetch() needs http:// (not file://).
 */

import { existsSync } from "fs";
import { join, normalize, relative } from "path";
import { spawnSync } from "child_process";

const ROOT = join(import.meta.dir, "..");
const DOCS = join(ROOT, "docs");
const NO_BUILD = process.argv.includes("--no-build");
const PORT = Number(process.env["PORT"] ?? "8787");

function runBuildPages(): void {
  const r = spawnSync("bun", [join(ROOT, "scripts", "build-pages.ts")], {
    cwd: ROOT,
    stdio: "inherit",
    shell: false,
  });
  if (r.status !== 0 && r.status !== null) {
    console.error("build-pages failed; fix errors or run with --no-build to serve existing data.");
    process.exit(r.status);
  }
}

function safePath(pathname: string): string | null {
  const decoded = decodeURIComponent(pathname);
  if (decoded.includes("\0")) return null;
  let rel = decoded;
  if (rel === "/" || rel === "") rel = "/index.html";
  const candidate = normalize(join(DOCS, rel));
  const docsNorm = normalize(DOCS);
  if (!candidate.startsWith(docsNorm)) return null;
  if (!existsSync(candidate)) return null;
  const statRel = relative(docsNorm, candidate);
  if (statRel.startsWith("..")) return null;
  return candidate;
}

if (!NO_BUILD) {
  runBuildPages();
}

if (!existsSync(join(DOCS, "index.html"))) {
  console.error(`Missing ${join("docs", "index.html")} — is the repo intact?`);
  process.exit(1);
}

const host = process.env["DASHBOARD_HOST"] ?? "127.0.0.1";
const url = `http://${host}:${PORT}/`;

Bun.serve({
  hostname: host,
  port: PORT,
  fetch(req) {
    const path = safePath(new URL(req.url).pathname);
    if (path === null) {
      return new Response("Not Found", { status: 404, headers: { "Content-Type": "text/plain" } });
    }
    return new Response(Bun.file(path));
  },
});

console.log(`\nAgent Forge dashboard → ${url}`);
console.log("Press Ctrl+C to stop.\n");
