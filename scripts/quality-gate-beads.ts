/**
 * What the quality gate asks Beads about the issue a run is correlated to.
 *
 * Two things keep a value out of a shell here, and both are needed. The only
 * id `bd` is given is a `BeadsIssueId`: a value that came out of a validated
 * run correlation and holds nothing a shell could act on. Nothing read from a
 * hook payload can be passed, by type. And `bd` is run with an argument array
 * through a runner that refuses the one target a shell would still parse them
 * for (a Windows batch file).
 */

import { execFileSync } from "child_process";
import { isAbsolute } from "path";
import type { CloseGateIssueType } from "./close-testing-attestation";
import type { BeadsIssueId } from "./run-correlation";

export type ExecFile = (
  file: string,
  args: readonly string[],
  /** `path` replaces PATH for finding `file` (tests). */
  opts?: { cwd?: string; path?: string },
) => { ok: boolean; output: string };

/** A file only cmd.exe can run, and cmd.exe parses the arguments it is given. */
const BATCH_FILE = /\.(cmd|bat)$/i;

/**
 * Run a program with its arguments as given, without a shell.
 *
 * The program is found first, because on Windows a bare name can resolve to a
 * batch shim, and spawning one goes through cmd.exe whatever API is used. A
 * batch file is refused: the call fails rather than reach a shell.
 */
export const execFileNoShell: ExecFile = (file, args, opts = {}) => {
  const program = isAbsolute(file)
    ? file
    : Bun.which(file, opts.path !== undefined ? { PATH: opts.path } : {});
  if (program === null) return { ok: false, output: `${file} is not on PATH` };
  if (process.platform === "win32" && BATCH_FILE.test(program)) {
    return {
      ok: false,
      output: `${file} resolves to a batch file (${program}), which only a shell can run`,
    };
  }
  try {
    const output = execFileSync(program, [...args], {
      ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 120_000,
    });
    return { ok: true, output: output.trim() };
  } catch (err: unknown) {
    const e = err as { stdout?: unknown; stderr?: unknown };
    const part = (value: unknown): string =>
      typeof value === "string" ? value : "";
    return { ok: false, output: part(e.stdout) + part(e.stderr) };
  }
};

type BdIssueJson = { issue_type?: string; type?: string } | null;

function issueTypeFromBdShowJson(output: string): CloseGateIssueType {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return "unknown";
  }
  const rows = Array.isArray(parsed) ? parsed : [];
  const first = (rows[0] ?? null) as BdIssueJson;
  const raw = String(first?.issue_type ?? first?.type ?? "")
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
  /** True when `bd show` lists acceptance criteria for it. */
  acceptanceListed: boolean;
  commentBodies: string[];
}

/** The issue's type, whether it lists acceptance criteria, and its comments. */
export function readBeadsIssue(
  id: BeadsIssueId,
  exec: ExecFile = execFileNoShell,
): BeadsIssueFacts {
  const json = exec("bd", ["show", id, "--json"]);
  const shown = exec("bd", ["show", id]);
  const comments = exec("bd", ["comments", id, "--json"]);
  return {
    shown: json.ok,
    issueType: json.ok ? issueTypeFromBdShowJson(json.output) : "unknown",
    acceptanceListed: shown.ok && shown.output.includes("ac:"),
    commentBodies: comments.ok
      ? commentBodiesFromBdCommentsJson(comments.output)
      : [],
  };
}
