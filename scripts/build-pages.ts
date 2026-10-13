#!/usr/bin/env bun

/**
 * build-pages.ts — Generate docs/data/beads.json for the dashboard.
 *
 * One source rule:
 * 1. The live tracker: `bd export --no-memories`, one call. Its rows carry each
 *    issue's dependencies and comments, so no per-issue `bd comments` call is made.
 * 2. Only when bd does not answer: `.beads/issues.jsonl` (a file an earlier
 *    `bd export` wrote, same row shape). The fallback is printed, and the
 *    payload's `source` records the file, its age and why bd was not used.
 * With neither, nothing is written and the command exits 1.
 *
 * Usage: bun run build-pages
 */

import { execFile } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { BeadsPayload, SnapshotSource } from "../types/beads";
import {
  type BdExportRow,
  commentsFromExportRows,
  issueRowsOf,
  issuesAndDepsFromExportRows,
  parseBdExportStdout,
  payloadFromIssuesDepsComments,
} from "./beads-dashboard";

/** Runs `bd` with these arguments; resolves to its stdout, rejects when bd fails. */
export type BdRunner = (args: string[]) => Promise<string>;

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

const EXPORT_ARGS = ["export", "--no-memories"];
/** The fallback file, relative to the checkout. */
const FALLBACK_FILE = ".beads/issues.jsonl";
const REASON_MAX = 500;

function reasonOf(error: unknown): string {
  const text = (error instanceof Error ? error.message : String(error)).trim();
  return text.length > REASON_MAX ? `${text.slice(0, REASON_MAX)}…` : text;
}

type TrackerRead =
  | { ok: true; rows: BdExportRow[] }
  | { ok: false; reason: string };

/** One `bd export`. Output with text but no issue rows in it is not an answer. */
async function readTracker(runBd: BdRunner): Promise<TrackerRead> {
  let stdout: string;
  try {
    stdout = await runBd(EXPORT_ARGS);
  } catch (error) {
    return { ok: false, reason: reasonOf(error) };
  }
  const rows = issueRowsOf(parseBdExportStdout(stdout));
  if (rows.length === 0 && stdout.trim() !== "") {
    return {
      ok: false,
      reason: reasonOf(`bd export printed no issue rows: ${stdout.trim()}`),
    };
  }
  return { ok: true, rows };
}

/** The fallback file's issue rows, or null when it is missing or holds none. */
function readFallbackFile(
  cwd: string,
): { rows: BdExportRow[]; modifiedAt: string } | null {
  const path = join(cwd, FALLBACK_FILE);
  if (!existsSync(path)) return null;
  const rows = issueRowsOf(parseBdExportStdout(readFileSync(path, "utf8")));
  if (rows.length === 0) return null;
  return { rows, modifiedAt: statSync(path).mtime.toISOString() };
}

export async function buildPages(
  options: BuildPagesOptions,
): Promise<BuildPagesResult> {
  const log = options.log ?? ((line: string) => console.log(line));
  const warn = options.warn ?? ((line: string) => console.warn(line));
  const outputDir = join(options.cwd, "docs", "data");
  const outputFile = join(outputDir, "beads.json");

  let rows: BdExportRow[];
  let source: SnapshotSource;
  const tracker = await readTracker(options.runBd);
  if (tracker.ok) {
    rows = tracker.rows;
    source = { kind: "tracker" };
  } else {
    const file = readFallbackFile(options.cwd);
    if (!file) {
      const error = [
        `build-pages: refusing to write a snapshot. \`bd export\` did not answer (${tracker.reason}), and there are no issues in ${FALLBACK_FILE} to fall back to.`,
        "Fix: start the Beads Dolt server (`bd dolt start`), ensure `bd` is on PATH, then re-run `bun run build-pages`.",
      ].join("\n");
      warn(error);
      return { ok: false, error };
    }
    rows = file.rows;
    source = {
      kind: "file",
      path: FALLBACK_FILE,
      modifiedAt: file.modifiedAt,
      reason: tracker.reason,
    };
    warn(
      `build-pages: \`bd export\` did not answer (${tracker.reason}). Falling back to ${FALLBACK_FILE}, last written ${file.modifiedAt}; it may be older than the tracker.`,
    );
  }

  const { issues, deps } = issuesAndDepsFromExportRows(rows);
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

const BD_TIMEOUT_MS = 60_000;

/** The real `bd`, found on PATH; gives up after a minute so a stuck bd falls back. */
export const runBdOnPath: BdRunner = (args) =>
  new Promise((resolve, reject) => {
    execFile(
      "bd",
      args,
      {
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
        timeout: BD_TIMEOUT_MS,
        windowsHide: true,
      },
      (error, stdout) => {
        if (!error) resolve(stdout);
        else if (error.killed)
          reject(
            new Error(
              `bd ${args.join(" ")} did not finish in ${BD_TIMEOUT_MS / 1000} s`,
            ),
          );
        else reject(error);
      },
    );
  });

if (import.meta.main) {
  const result = await buildPages({ cwd: process.cwd(), runBd: runBdOnPath });
  if (!result.ok) process.exit(1);
}
