#!/usr/bin/env bun

/**
 * build-pages.ts — Generate docs/data/beads.json for the dashboard.
 *
 * 1. Reads `.beads/*.jsonl` when present and non-empty (legacy / file-export flow).
 * 2. If that yields no issues, runs `bd export --no-memories` and normalizes records
 *    (Dolt-backed Beads — the usual case today).
 *
 * Usage: bun run build-pages
 */

import { execFileSync } from "child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import type {
  BeadsComment,
  BeadsDependency,
  BeadsIssue,
  BeadsPayload,
} from "../types/beads";
import {
  issuesAndDepsFromExportRows,
  parseBdCommentsJson,
  parseBdExportStdout,
  payloadFromIssuesDepsComments,
} from "./beads-dashboard";

const ISSUES_FILE = join(process.cwd(), ".beads", "issues.jsonl");
const DEPS_FILE = join(process.cwd(), ".beads", "deps.jsonl");
const COMMENTS_FILE = join(process.cwd(), ".beads", "comments.jsonl");
const OUTPUT_FILE = join(process.cwd(), "docs", "data", "beads.json");

function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => {
      try {
        return JSON.parse(line) as T;
      } catch {
        return null;
      }
    })
    .filter((x): x is T => x !== null);
}

function loadFromBdExport(): {
  issues: BeadsIssue[];
  deps: BeadsDependency[];
  comments: BeadsComment[];
} {
  const stdout = execFileSync("bd", ["export", "--no-memories"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const rows = parseBdExportStdout(stdout);
  const { issues, deps } = issuesAndDepsFromExportRows(rows);
  const comments: BeadsComment[] = [];
  for (const row of rows) {
    const n = row.comment_count;
    if (typeof n !== "number" || n <= 0) continue;
    try {
      const cOut = execFileSync("bd", ["comments", row.id, "--json"], {
        encoding: "utf8",
        maxBuffer: 32 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      });
      comments.push(...parseBdCommentsJson(cOut, row.id));
    } catch {
      /* skip — comment fetch is best-effort per issue */
    }
  }
  return { issues, deps, comments };
}

let issues = readJsonl<BeadsIssue>(ISSUES_FILE);
let deps = readJsonl<BeadsDependency>(DEPS_FILE);
let comments = readJsonl<BeadsComment>(COMMENTS_FILE);

/** When JSONL is empty we rely on `bd export`; if that throws, do not write a misleading empty snapshot. */
let bdExportFailed: Error | null = null;

if (issues.length === 0) {
  try {
    const fromBd = loadFromBdExport();
    issues = fromBd.issues;
    deps = fromBd.deps;
    comments = fromBd.comments;
    if (issues.length > 0) {
      console.log(
        "  (loaded issues via `bd export --no-memories` — JSONL was empty)",
      );
    }
  } catch (e) {
    bdExportFailed = e instanceof Error ? e : new Error(String(e));
    console.warn(
      "  (no JSONL issues and `bd export` failed — install bd in PATH, start Dolt, or export manually):",
      bdExportFailed.message,
    );
  }
}

if (issues.length === 0 && bdExportFailed) {
  console.error(
    "\nbuild-pages: refusing to write an empty dashboard snapshot because `bd export` failed.",
    "\nFix: start the Beads Dolt server (`bd dolt start`), ensure `bd` is on PATH, then re-run `bun run build-pages`.",
    "\n",
  );
  process.exit(1);
}

const { derived } = payloadFromIssuesDepsComments(issues, deps, comments);

const payload: BeadsPayload = {
  version: "1.0.0",
  generatedAt: new Date().toISOString(),
  issues,
  comments,
  deps,
  derived,
};

// Write output
mkdirSync(join(process.cwd(), "docs", "data"), { recursive: true });
writeFileSync(OUTPUT_FILE, JSON.stringify(payload, null, 2));

console.log(`✓ Built docs/data/beads.json`);
console.log(`  Issues: ${issues.length}`);
console.log(`  Comments: ${comments.length}`);
console.log(`  Ready: ${derived.ready.length}`);
console.log(`  Blocked: ${derived.blocked.length}`);
console.log(`  Deps: ${deps.length}`);
