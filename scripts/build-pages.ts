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

import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import type { BeadsIssue, BeadsComment, BeadsDependency, BeadsPayload } from "../types/beads";
import { payloadFromIssuesDepsComments } from "./beads-dashboard";
import { loadBeadsGraph } from "./beads/load-issues";

const OUTPUT_FILE = join(process.cwd(), "docs", "data", "beads.json");

const { issues, deps, comments } = loadBeadsGraph();

if (issues.length === 0) {
  console.warn(
    "  (no issues loaded — install bd in PATH or ensure .beads/issues.jsonl or bd export works)",
  );
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
