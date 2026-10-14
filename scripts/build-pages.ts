#!/usr/bin/env bun

/**
 * build-pages.ts — Generate docs/data/beads.json for the dashboard.
 *
 * One source rule (read by `scripts/beads/live-tracker.ts`):
 * 1. The live tracker: `bd export --no-memories`, one call. Its rows carry each
 *    issue's dependencies and comments, so no per-issue `bd comments` call is made.
 * 2. Only when bd does not answer: `.beads/issues.jsonl` (a file an earlier
 *    `bd export` wrote, same row shape). The fallback is printed, and the
 *    payload's `source` records the file, its age and why bd was not used.
 * With neither, nothing is written and the command exits 1.
 *
 * Each issue's repository (the Repo column) also reads the machine-local
 * `repos/repos.json` and `repos/issue-repos.json`; `scripts/beads/issue-repo.ts`
 * has the rule. A file under `repos/` that cannot be used is warned about.
 *
 * Usage: bun run build-pages
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BeadsPayload } from "../types/beads";
import {
  type BdRunner,
  FALLBACK_FILE,
  fallbackNotice,
  readTrackerRows,
  runBdOnPath,
} from "./beads/live-tracker";
import { readRepoContext } from "./beads/repo-context";
import {
  commentsFromExportRows,
  issuesAndDepsFromExportRows,
  payloadFromIssuesDepsComments,
} from "./beads-dashboard";

export interface BuildPagesOptions {
  /** The checkout whose `.beads/` and `docs/data/` are used. */
  cwd: string;
  runBd: BdRunner;
  log?: (line: string) => void;
  warn?: (line: string) => void;
}

export type BuildPagesResult =
  | { ok: true; payload: BeadsPayload; outputFile: string }
  | { ok: false; error: string };

export async function buildPages(
  options: BuildPagesOptions,
): Promise<BuildPagesResult> {
  const log = options.log ?? ((line: string) => console.log(line));
  const warn = options.warn ?? ((line: string) => console.warn(line));
  const outputDir = join(options.cwd, "docs", "data");
  const outputFile = join(outputDir, "beads.json");

  const read = await readTrackerRows(options);
  if (!read.ok) {
    const error = [
      `build-pages: refusing to write a snapshot. \`bd export\` did not answer (${read.reason}), and there are no issues in ${FALLBACK_FILE} to fall back to.`,
      "Fix: start the Beads Dolt server (`bd dolt start`), ensure `bd` is on PATH, then re-run `bun run build-pages`.",
    ].join("\n");
    warn(error);
    return { ok: false, error };
  }
  const { rows, source } = read;
  if (source.kind === "file") warn(`build-pages: ${fallbackNotice(source)}`);

  const repoContext = readRepoContext(options.cwd);
  for (const line of repoContext.warnings) warn(`build-pages: ${line}`);
  const { issues, deps } = issuesAndDepsFromExportRows(
    rows,
    repoContext.context,
  );
  const { comments, short } = commentsFromExportRows(rows);
  if (short.length > 0) {
    const shown = short.slice(0, 10).join(", ");
    const more = short.length > 10 ? ` and ${short.length - 10} more` : "";
    warn(
      `build-pages: ${short.length} issue(s) count more comments than the export carried; the missing ones are left out: ${shown}${more}`,
    );
  }

  const { derived } = payloadFromIssuesDepsComments(issues, deps, comments);
  const payload: BeadsPayload = {
    version: "1.0.0",
    generatedAt: new Date().toISOString(),
    source,
    issues,
    comments,
    deps,
    derived,
  };

  mkdirSync(outputDir, { recursive: true });
  writeFileSync(outputFile, JSON.stringify(payload, null, 2));

  log(
    `✓ Built docs/data/beads.json from ${
      source.kind === "tracker"
        ? "the live tracker (bd export)"
        : `${source.path} (fallback)`
    }`,
  );
  log(`  Issues: ${issues.length}`);
  log(`  Comments: ${comments.length}`);
  log(`  Ready: ${derived.ready.length}`);
  log(`  Blocked: ${derived.blocked.length}`);
  log(`  Deps: ${deps.length}`);
  return { ok: true, payload, outputFile };
}

if (import.meta.main) {
  const result = await buildPages({ cwd: process.cwd(), runBd: runBdOnPath });
  if (!result.ok) process.exit(1);
}
