/**
 * The one reader of the tracker's issue rows for scripts that run outside the
 * hearth (build-pages, tmp-work-cleanup, convoy-bundles).
 *
 * One source rule:
 * 1. The live tracker: `bd export --no-memories`, one call.
 * 2. Only when bd does not answer: `.beads/issues.jsonl`, a file an earlier
 *    `bd export` wrote, in the same row shape. The result's `source` records
 *    the file, its age and why bd was not used, so the caller can say so.
 *
 * Rows come back as `bd export` prints them; normalize them with
 * `issuesAndDepsFromExportRows` (`scripts/beads-dashboard.ts`).
 */

import { execFile } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { SnapshotSource } from "../../types/beads";
import {
  type BdExportRow,
  issueRowsOf,
  parseBdExportStdout,
} from "../beads-dashboard";

/** Runs `bd` with these arguments; resolves to its stdout, rejects when bd fails. */
export type BdRunner = (args: string[]) => Promise<string>;

export const EXPORT_ARGS = ["export", "--no-memories"];
/** The fallback file, relative to the checkout. */
export const FALLBACK_FILE = ".beads/issues.jsonl";
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

export type TrackerRows =
  | { ok: true; rows: BdExportRow[]; source: SnapshotSource }
  /** Neither bd nor the file answered; `reason` is bd's failure. */
  | { ok: false; reason: string };

/**
 * The issue rows of the checkout at `cwd`: the live tracker's when bd answers,
 * else the fallback file's, with `source` saying which.
 */
export async function readTrackerRows(options: {
  /** The checkout whose `.beads/issues.jsonl` is the fallback. */
  cwd: string;
  runBd: BdRunner;
}): Promise<TrackerRows> {
  const tracker = await readTracker(options.runBd);
  if (tracker.ok)
    return { ok: true, rows: tracker.rows, source: { kind: "tracker" } };
  const file = readFallbackFile(options.cwd);
  if (!file) return { ok: false, reason: tracker.reason };
  return {
    ok: true,
    rows: file.rows,
    source: {
      kind: "file",
      path: FALLBACK_FILE,
      modifiedAt: file.modifiedAt,
      reason: tracker.reason,
    },
  };
}

/** The sentence a caller prints when the rows came from the fallback file. */
export function fallbackNotice(
  source: Extract<SnapshotSource, { kind: "file" }>,
): string {
  return `\`bd export\` did not answer (${source.reason}). Falling back to ${source.path}, last written ${source.modifiedAt}; it may be older than the tracker.`;
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
