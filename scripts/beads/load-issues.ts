/**
 * Shared loader for harness Beads data (JSONL snapshot or live `bd export`).
 * Used by `build-pages.ts`, `stale-work-patrol.ts`, and future scripts.
 */

import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { execFileSync } from "child_process";
import type { BeadsIssue, BeadsDependency, BeadsComment } from "../../types/beads";
import {
  issuesAndDepsFromExportRows,
  parseBdCommentsJson,
  parseBdExportStdout,
} from "../beads-dashboard";

const ISSUES_FILE = join(process.cwd(), ".beads", "issues.jsonl");
const DEPS_FILE = join(process.cwd(), ".beads", "deps.jsonl");
const COMMENTS_FILE = join(process.cwd(), ".beads", "comments.jsonl");

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

/**
 * Load issues, deps, and comments the same way as dashboard `build-pages`.
 */
export function loadBeadsGraph(): {
  issues: BeadsIssue[];
  deps: BeadsDependency[];
  comments: BeadsComment[];
} {
  let issues = readJsonl<BeadsIssue>(ISSUES_FILE);
  let deps = readJsonl<BeadsDependency>(DEPS_FILE);
  let comments = readJsonl<BeadsComment>(COMMENTS_FILE);

  if (issues.length === 0) {
    const fromBd = loadFromBdExport();
    issues = fromBd.issues;
    deps = fromBd.deps;
    comments = fromBd.comments;
  }

  return { issues, deps, comments };
}
