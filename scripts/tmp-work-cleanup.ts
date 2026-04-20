#!/usr/bin/env bun
/**
 * Sweep `.tmp/work/<TASK-ID>-*` files for **closed** Beads issues older than TTL.
 * Default: dry-run (lists candidates). Pass `--apply` to actually delete.
 *
 * Env:
 *   TTL_DAYS — retention days (default 14).
 *
 * Protects:
 *   - Any file not matching /^[a-z0-9-]+-.+/ prefix
 *   - `session-handoff.md`
 *   - `<EPIC-ID>-interfaces.md` (suffix `-interfaces.md`)
 *   - Any file whose prefix matches an open/in_progress/blocked Beads issue.
 *
 * Emits `{ ok, data, error }` JSON envelope.
 */

import { readdirSync, readFileSync, existsSync, statSync, unlinkSync } from "fs";
import { join } from "path";
import { execFileSync } from "child_process";
import type { BeadsIssue } from "../types/beads";
import { issuesAndDepsFromExportRows, parseBdExportStdout } from "./beads-dashboard";

const ISSUES_FILE = join(process.cwd(), ".beads", "issues.jsonl");

function loadIssues(): BeadsIssue[] {
  if (existsSync(ISSUES_FILE)) {
    const lines = readFileSync(ISSUES_FILE, "utf8")
      .split("\n")
      .filter((l) => l.trim());
    const out: BeadsIssue[] = [];
    for (const l of lines) {
      try {
        out.push(JSON.parse(l) as BeadsIssue);
      } catch {
        /* skip malformed */
      }
    }
    if (out.length > 0) return out;
  }
  const stdout = execFileSync("bd", ["export", "--no-memories"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const { issues } = issuesAndDepsFromExportRows(parseBdExportStdout(stdout));
  return issues;
}

const TMP_WORK = join(process.cwd(), ".tmp", "work");

export type SweepCandidate = {
  path: string;
  taskId: string;
  ageDays: number;
  action: "skip" | "delete";
  reason: string;
};

const SAFE_NAMES = new Set(["session-handoff.md"]);

export function classifyFile(
  name: string,
  ageDays: number,
  issuesById: Map<string, BeadsIssue>,
  ttlDays: number,
): SweepCandidate | null {
  if (SAFE_NAMES.has(name)) return null;
  if (name.endsWith("-interfaces.md")) return null;

  const m = name.match(/^([a-z0-9][a-z0-9-]*-[a-z0-9]+)-/);
  if (!m || !m[1]) return null;

  const taskId = m[1];
  const path = join(TMP_WORK, name);
  const issue = issuesById.get(taskId);
  if (!issue) {
    return {
      path,
      taskId,
      ageDays,
      action: "skip",
      reason: `bead ${taskId} not in ledger`,
    };
  }
  if (issue.status !== "closed") {
    return {
      path,
      taskId,
      ageDays,
      action: "skip",
      reason: `bead ${taskId} status=${issue.status}`,
    };
  }
  if (ageDays < ttlDays) {
    return {
      path,
      taskId,
      ageDays,
      action: "skip",
      reason: `age ${ageDays}d < TTL ${ttlDays}d`,
    };
  }
  return {
    path,
    taskId,
    ageDays,
    action: "delete",
    reason: `closed bead, age ${ageDays}d ≥ TTL ${ttlDays}d`,
  };
}

function listFiles(): string[] {
  try {
    return readdirSync(TMP_WORK).filter((name) => {
      try {
        return statSync(join(TMP_WORK, name)).isFile();
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }
}

function parseTtl(): number {
  const raw = process.env["TTL_DAYS"]?.trim() ?? "14";
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return 14;
  return Math.floor(n);
}

function main(): void {
  const apply = process.argv.includes("--apply");
  const ttlDays = parseTtl();
  const nowMs = Date.now();

  let issues: BeadsIssue[] = [];
  try {
    issues = loadIssues();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log(JSON.stringify({ ok: false, data: null, error: msg }, null, 2));
    process.exit(1);
  }
  const byId = new Map<string, BeadsIssue>();
  for (const i of issues) byId.set(i.id, i);

  const files = listFiles();
  const candidates: SweepCandidate[] = [];
  for (const name of files) {
    const abs = join(TMP_WORK, name);
    let ageDays = 0;
    try {
      const ms = statSync(abs).mtimeMs;
      ageDays = Math.floor((nowMs - ms) / 86_400_000);
    } catch {
      continue;
    }
    const c = classifyFile(name, ageDays, byId, ttlDays);
    if (c) candidates.push(c);
  }

  const toDelete = candidates.filter((c) => c.action === "delete");
  const deleted: string[] = [];
  if (apply) {
    for (const c of toDelete) {
      try {
        unlinkSync(c.path);
        deleted.push(c.path);
      } catch (e) {
        // best effort
        console.error(`warn: could not delete ${c.path}: ${(e as Error).message}`);
      }
    }
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        data: {
          ttlDays,
          apply,
          scanned: files.length,
          candidates,
          deleted,
        },
        error: null,
      },
      null,
      2,
    ),
  );
}

if (import.meta.main) {
  main();
}
