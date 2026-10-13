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
 * Also sweeps evaluator verdicts under `.tmp/work/evaluations/`, by the same
 * closed-bead and age rule, and only a file it can validate (a schema 2
 * verdict in the directory its run id declares, behind no link) whose digest
 * the event ledger already holds: see `sweepEvaluations`.
 *
 * Which beads are closed comes from the live tracker (one `bd export`). Only
 * when bd does not answer is `.beads/issues.jsonl` used: a warning says so on
 * stderr before anything is removed, and the envelope's `data.source` names
 * the file, when it was last written and why bd was not used. With neither,
 * nothing is swept.
 *
 * Emits `{ ok, data, error }` JSON envelope.
 */

import {
  lstatSync,
  readdirSync,
  realpathSync,
  rmdirSync,
  statSync,
  unlinkSync,
} from "fs";
import { join } from "path";
import type { BeadsIssue, SnapshotSource } from "../types/beads";
import {
  type BdRunner,
  FALLBACK_FILE,
  fallbackNotice,
  readTrackerRows,
  runBdOnPath,
} from "./beads/live-tracker";
import { issuesAndDepsFromExportRows } from "./beads-dashboard";
import {
  EVAL_VERDICT_SCHEMA_VERSION,
  parseEvalVerdictJson,
} from "./eval-verdict";
import {
  EVALUATIONS_DIR,
  evaluationDir,
  isEvaluationDirName,
  isManagedVerdictFile,
  readEvaluationFile,
} from "./eval-verdict-store";
import { comparableCheckout } from "./forge/runs";
import { queryEvents } from "./ledger/query";
import { resolveCheckout } from "./ledger/workspace";

/**
 * How many days old a file must be (since it was last written) before it may
 * be swept, once its bead is closed, unless `TTL_DAYS` says otherwise. One
 * period for task-scoped files and evaluator verdicts alike: the retention
 * policy still to be decided (bead ulpz.1) replaces this value.
 */
export const DEFAULT_TTL_DAYS = 14;

/**
 * The issues whose statuses decide what is swept: the live tracker's when bd
 * answers, else `.beads/issues.jsonl`'s, and `source` says which.
 */
async function loadIssues(
  cwd: string,
  runBd: BdRunner,
): Promise<
  | { ok: true; issues: BeadsIssue[]; source: SnapshotSource }
  | { ok: false; error: string }
> {
  const read = await readTrackerRows({ cwd, runBd });
  if (!read.ok) {
    return {
      ok: false,
      error: `tmp-work-cleanup: nothing swept. \`bd export\` did not answer (${read.reason}), and there are no issues in ${FALLBACK_FILE} to fall back to.`,
    };
  }
  const { issues } = issuesAndDepsFromExportRows(read.rows);
  return { ok: true, issues, source: read.source };
}

/** The directory swept for task-scoped files, under a checkout. */
function tmpWorkOf(cwd: string): string {
  return join(cwd, ".tmp", "work");
}

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
  /** The directory the file is in. Default: `.tmp/work` under the current directory. */
  workDir: string = tmpWorkOf(process.cwd()),
): SweepCandidate | null {
  if (SAFE_NAMES.has(name)) return null;
  if (name.endsWith("-interfaces.md")) return null;

  const m = name.match(/^([a-z0-9][a-z0-9-]*-[a-z0-9]+)-/);
  if (!m || !m[1]) return null;

  const taskId = m[1];
  const path = join(workDir, name);
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

function listFiles(workDir: string): string[] {
  try {
    return readdirSync(workDir).filter((name) => {
      try {
        return statSync(join(workDir, name)).isFile();
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }
}

function parseTtl(): number {
  const raw = process.env["TTL_DAYS"]?.trim() ?? String(DEFAULT_TTL_DAYS);
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_TTL_DAYS;
  return Math.floor(n);
}

// ── Evaluator verdicts ──────────────────────────────────────────────────────

/** A verdict file's digest and the run it names: what the ledger is asked for. */
export interface LedgerDigest {
  sha256: string;
  executionRunId: string;
}

/**
 * True when the ledger holds a `verdict.bound` for that run whose file
 * reference carries exactly that digest. A ledger that cannot be read holds
 * nothing: the sweep then removes nothing.
 */
export function ledgerHoldsVerdict(
  digest: LedgerDigest,
  opts: { path?: string } = {},
): boolean {
  try {
    return queryEvents(
      { runId: digest.executionRunId, kinds: ["verdict.bound"] },
      opts,
    ).some(
      (event) =>
        event.kind === "verdict.bound" &&
        event.payload.verdictArtifact?.sha256 === digest.sha256,
    );
  } catch {
    return false;
  }
}

export interface EvaluationSweep {
  /** Paths are relative to the checkout. */
  candidates: SweepCandidate[];
  deleted: string[];
  /** Set when the whole evaluations directory was left alone, and why. */
  note?: string;
}

/** True when `relative` under the checkout root exists as a real directory of the checkout's own: not a link. */
function isOwnDirectory(root: string, relative: string): boolean {
  const path = `${root}/${relative}`;
  try {
    return (
      lstatSync(path).isDirectory() &&
      comparableCheckout(realpathSync.native(path)) === path
    );
  } catch {
    return false;
  }
}

/**
 * Sweep the evaluator verdicts of a checkout.
 *
 * A file is a candidate only when it is where the path rule puts verdicts: a
 * managed file name in a directory named by 64 hex digits, in the checkout's
 * own evaluations directory, with no link anywhere on the way. It is removed
 * only when all of this holds:
 *
 * - its bytes are a schema 2 verdict whose run id hashes to the directory it
 *   is in (so the file is the one that run declared, not a stray copy);
 * - the Beads issue it names is closed, and the file is older than the TTL;
 * - the ledger holds a `verdict.bound` for that run with the file's digest.
 *   Until then the file is the only copy of that evidence.
 *
 * Files are unlinked one at a time; a run's directory is removed only by the
 * sweep that emptied it. Anything else found there is left as it is.
 *
 * `checkout` must be the top level of a checkout: from a directory inside one
 * nothing is swept, so the issues consulted and the files removed are always
 * the same checkout's.
 */
export function sweepEvaluations(input: {
  /** The top level of the checkout to sweep. */
  checkout: string;
  issuesById: Map<string, BeadsIssue>;
  ttlDays: number;
  ledgerHolds(digest: LedgerDigest): boolean;
  apply: boolean;
  nowMs: number;
}): EvaluationSweep {
  const root = resolveCheckout(input.checkout).worktree;
  const candidates: SweepCandidate[] = [];
  const deleted: string[] = [];
  let given: string;
  try {
    given = comparableCheckout(realpathSync.native(input.checkout));
  } catch {
    return { candidates, deleted };
  }
  if (given !== root) {
    return {
      candidates,
      deleted,
      note: "evaluations are swept from the top level of a checkout: this directory is inside one",
    };
  }
  try {
    lstatSync(`${root}/${EVALUATIONS_DIR}`);
  } catch {
    return { candidates, deleted };
  }
  if (!isOwnDirectory(root, EVALUATIONS_DIR)) {
    return {
      candidates,
      deleted,
      note: `${EVALUATIONS_DIR} is, or sits under, a link: nothing in it is swept`,
    };
  }

  for (const dir of readdirSync(`${root}/${EVALUATIONS_DIR}`).sort()) {
    const relativeDir = `${EVALUATIONS_DIR}/${dir}`;
    if (!isEvaluationDirName(dir) || !isOwnDirectory(root, relativeDir)) {
      continue;
    }
    let removedHere = 0;
    for (const file of readdirSync(`${root}/${relativeDir}`).sort()) {
      if (!isManagedVerdictFile(file)) continue;
      const relative = `${relativeDir}/${file}`;
      const candidate = classifyEvaluationFile(root, dir, file, input);
      candidates.push({ ...candidate, path: relative });
      if (candidate.action !== "delete" || !input.apply) continue;
      try {
        unlinkSync(`${root}/${relative}`);
        deleted.push(relative);
        removedHere++;
      } catch (e) {
        console.error(
          `warn: could not delete ${relative}: ${(e as Error).message}`,
        );
      }
    }
    // Only a directory this sweep emptied: one found empty is not its to judge.
    if (removedHere > 0) {
      try {
        // Fails, as it should, while anything is left in the directory.
        rmdirSync(`${root}/${relativeDir}`);
      } catch {
        // Not empty, or not removable: it stays.
      }
    }
  }
  return { candidates, deleted };
}

/** What to do with one managed file of one evaluation directory. */
function classifyEvaluationFile(
  root: string,
  dir: string,
  file: string,
  input: {
    issuesById: Map<string, BeadsIssue>;
    ttlDays: number;
    ledgerHolds(digest: LedgerDigest): boolean;
    nowMs: number;
  },
): Omit<SweepCandidate, "path"> {
  const skip = (
    reason: string,
    taskId = "",
    ageDays = 0,
  ): Omit<SweepCandidate, "path"> => ({
    taskId,
    ageDays,
    action: "skip",
    reason,
  });
  const read = readEvaluationFile({ checkout: root, dir, file });
  if (!read.ok) return skip(read.error);
  const parsed = parseEvalVerdictJson(read.buffer.toString("utf8"));
  if (
    !parsed.ok ||
    parsed.value.schemaVersion !== EVAL_VERDICT_SCHEMA_VERSION
  ) {
    return skip("not a schema 2 verdict");
  }
  const verdict = parsed.value;
  if (evaluationDir(verdict.executionRunId) !== `${EVALUATIONS_DIR}/${dir}`) {
    return skip(
      `the verdict names run ${verdict.executionRunId}, which this directory is not the directory of`,
      verdict.beadsIssueId,
    );
  }
  let ageDays = 0;
  try {
    const modified = statSync(`${root}/${read.path}`).mtimeMs;
    ageDays = Math.floor((input.nowMs - modified) / 86_400_000);
  } catch {
    return skip("the file's age could not be read", verdict.beadsIssueId);
  }
  const taskId = verdict.beadsIssueId;
  const issue = input.issuesById.get(taskId);
  if (!issue) return skip(`bead ${taskId} not in ledger`, taskId, ageDays);
  if (issue.status !== "closed") {
    return skip(`bead ${taskId} status=${issue.status}`, taskId, ageDays);
  }
  if (ageDays < input.ttlDays) {
    return skip(`age ${ageDays}d < TTL ${input.ttlDays}d`, taskId, ageDays);
  }
  if (
    !input.ledgerHolds({
      sha256: read.sha256,
      executionRunId: verdict.executionRunId,
    })
  ) {
    return skip(
      "the ledger holds no verdict.bound with this file's digest for its run",
      taskId,
      ageDays,
    );
  }
  return {
    taskId,
    ageDays,
    action: "delete",
    reason: `closed bead, age ${ageDays}d ≥ TTL ${input.ttlDays}d, digest held by the ledger`,
  };
}

export interface TmpWorkCleanupOptions {
  /** The checkout whose `.tmp/work` is swept. */
  cwd: string;
  runBd: BdRunner;
  apply: boolean;
  ttlDays: number;
  nowMs: number;
  /** Default: the event ledger (`ledgerHoldsVerdict`). */
  ledgerHolds?: (digest: LedgerDigest) => boolean;
  warn?: (line: string) => void;
}

export type TmpWorkCleanupEnvelope =
  | {
      ok: true;
      data: {
        ttlDays: number;
        apply: boolean;
        /** Where the bead statuses came from: the live tracker, or the fallback file. */
        source: SnapshotSource;
        scanned: number;
        candidates: SweepCandidate[];
        deleted: string[];
        evaluations: EvaluationSweep;
      };
      error: null;
    }
  | { ok: false; data: null; error: string };

/** One sweep of a checkout's `.tmp/work`: what `bun run tmp:cleanup` prints. */
export async function runTmpWorkCleanup(
  options: TmpWorkCleanupOptions,
): Promise<TmpWorkCleanupEnvelope> {
  const { apply, ttlDays, nowMs } = options;
  const warn = options.warn ?? ((line: string) => console.error(line));
  const workDir = tmpWorkOf(options.cwd);

  const loaded = await loadIssues(options.cwd, options.runBd);
  if (!loaded.ok) return { ok: false, data: null, error: loaded.error };
  const { issues, source } = loaded;
  // Said before anything is removed: the statuses may be older than the tracker's.
  if (source.kind === "file") {
    warn(
      `tmp-work-cleanup: ${fallbackNotice(source)} Closed beads are taken from that file, and --apply deletes by it.`,
    );
  }
  const byId = new Map<string, BeadsIssue>();
  for (const i of issues) byId.set(i.id, i);

  const files = listFiles(workDir);
  const candidates: SweepCandidate[] = [];
  for (const name of files) {
    const abs = join(workDir, name);
    let ageDays = 0;
    try {
      const ms = statSync(abs).mtimeMs;
      ageDays = Math.floor((nowMs - ms) / 86_400_000);
    } catch {
      continue;
    }
    const c = classifyFile(name, ageDays, byId, ttlDays, workDir);
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
        warn(`warn: could not delete ${c.path}: ${(e as Error).message}`);
      }
    }
  }

  // Evaluator verdicts, in this same directory's checkout. A failure here is
  // reported in the envelope: the task-scoped files above are already done.
  let evaluations: EvaluationSweep;
  try {
    evaluations = sweepEvaluations({
      checkout: options.cwd,
      issuesById: byId,
      ttlDays,
      ledgerHolds:
        options.ledgerHolds ?? ((digest) => ledgerHoldsVerdict(digest)),
      apply,
      nowMs,
    });
  } catch (e) {
    evaluations = {
      candidates: [],
      deleted: [],
      note: `evaluations were not swept: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  return {
    ok: true,
    data: {
      ttlDays,
      apply,
      source,
      scanned: files.length,
      candidates,
      deleted,
      evaluations,
    },
    error: null,
  };
}

if (import.meta.main) {
  const envelope = await runTmpWorkCleanup({
    cwd: process.cwd(),
    runBd: runBdOnPath,
    apply: process.argv.includes("--apply"),
    ttlDays: parseTtl(),
    nowMs: Date.now(),
  });
  console.log(JSON.stringify(envelope, null, 2));
  if (!envelope.ok) process.exit(1);
}
