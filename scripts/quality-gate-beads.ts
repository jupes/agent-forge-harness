/**
 * What the quality gate asks Beads about the issue a run is correlated to.
 *
 * Two things keep a value out of a shell here, and both are needed. The only
 * id `bd` is given is a `BeadsIssueId`: a value that came out of a validated
 * run correlation and holds nothing a shell could act on. Nothing read from a
 * hook payload can be passed, by type. And `bd` is run with an argument array
 * through a runner that, on Windows, runs only a real executable: anything
 * else there (a batch shim) is run by cmd.exe, which parses the arguments.
 */

import { execFileSync } from "child_process";
import { isAbsolute } from "path";
import type { CloseGateIssueType } from "./close-testing-attestation";
import type { BeadsIssueId } from "./run-correlation";
import { resetSpawnClock } from "./spawn-clock";

export type ExecFile = (
  file: string,
  args: readonly string[],
  /**
   * `path` replaces PATH for finding `file` (tests). `timeoutMs` is how long
   * the program may run before it is stopped (default `EXEC_TIMEOUT_MS`).
   */
  opts?: { cwd?: string; path?: string; timeoutMs?: number },
) => {
  ok: boolean;
  output: string;
  /** Set when the program was stopped for running past its time limit. */
  timedOut?: true;
};

/** What Windows runs directly. Anything else it hands to cmd.exe. */
const WINDOWS_EXECUTABLE = /\.(exe|com)$/i;

/** How long a program runs before it is stopped, unless the call says otherwise. */
export const EXEC_TIMEOUT_MS = 120_000;

/**
 * Run a program with its arguments as given, without a shell.
 *
 * The program is found first, because on Windows a name can resolve to a batch
 * shim — a bare name through PATH, a full path through the extension Windows
 * adds — and spawning one goes through cmd.exe whatever API is used. So on
 * Windows only a file named as a real executable is run; any other call fails
 * rather than reach a shell.
 */
export const execFileNoShell: ExecFile = (file, args, opts = {}) => {
  const program = isAbsolute(file)
    ? file
    : Bun.which(file, opts.path !== undefined ? { PATH: opts.path } : {});
  if (program === null) return { ok: false, output: `${file} is not on PATH` };
  if (process.platform === "win32" && !WINDOWS_EXECUTABLE.test(program)) {
    return {
      ok: false,
      output: `${file} resolves to ${program}, which is not an .exe or .com: only a shell could run it`,
    };
  }
  try {
    resetSpawnClock();
    const output = execFileSync(program, [...args], {
      ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: opts.timeoutMs ?? EXEC_TIMEOUT_MS,
    });
    return { ok: true, output: output.trim() };
  } catch (err: unknown) {
    const e = err as { stdout?: unknown; stderr?: unknown; code?: unknown };
    const part = (value: unknown): string =>
      typeof value === "string" ? value : "";
    const output = part(e.stdout) + part(e.stderr);
    // A program killed at its time limit, as against one that failed.
    return e.code === "ETIMEDOUT"
      ? { ok: false, output, timedOut: true }
      : { ok: false, output };
  }
};

type BdIssueJson = {
  issue_type?: unknown;
  type?: unknown;
  /** The issue's Acceptance Criteria field. bd leaves it out when it is empty. */
  acceptance_criteria?: unknown;
} | null;

/** The issue row `bd show <id> --json` prints, or null when the output holds none. */
function issueRowFromBdShowJson(output: string): BdIssueJson {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return null;
  }
  const first: unknown = Array.isArray(parsed) ? parsed[0] : null;
  // justification: a non-null object row; each field is checked where it is read.
  return typeof first === "object" && first !== null
    ? (first as BdIssueJson)
    : null;
}

function issueTypeFromRow(row: BdIssueJson): CloseGateIssueType {
  const raw = String(row?.issue_type ?? row?.type ?? "")
    .toLowerCase()
    .trim();
  if (
    raw === "epic" ||
    raw === "feature" ||
    raw === "task" ||
    raw === "bug" ||
    raw === "chore"
  )
    return raw;
  return "unknown";
}

function commentBodiesFromBdCommentsJson(output: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: string[] = [];
  for (const row of parsed) {
    if (!row || typeof row !== "object") continue;
    const text = (row as { text?: unknown }).text;
    if (typeof text === "string" && text.trim()) out.push(text);
  }
  return out;
}

export interface BeadsIssueFacts {
  /** False when `bd show` failed: no bd on the path, or no such issue. */
  shown: boolean;
  /** `unknown` when bd could not show the issue. */
  issueType: CloseGateIssueType;
  /**
   * True when the issue's Acceptance Criteria field, as `bd show --json`
   * prints it, holds text. An `ac:` comment or the text `ac:` elsewhere in the
   * issue is not the field.
   */
  acceptanceListed: boolean;
  commentBodies: string[];
}

/** The issue's type, whether it lists acceptance criteria, and its comments. */
export function readBeadsIssue(
  id: BeadsIssueId,
  exec: ExecFile = execFileNoShell,
): BeadsIssueFacts {
  const json = exec("bd", ["show", id, "--json"]);
  const comments = exec("bd", ["comments", id, "--json"]);
  const row = json.ok ? issueRowFromBdShowJson(json.output) : null;
  const acceptance = row?.acceptance_criteria;
  return {
    shown: json.ok,
    issueType: issueTypeFromRow(row),
    acceptanceListed:
      typeof acceptance === "string" && acceptance.trim().length > 0,
    commentBodies: comments.ok
      ? commentBodiesFromBdCommentsJson(comments.output)
      : [],
  };
}
