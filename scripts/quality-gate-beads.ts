/**
 * What the quality gate asks Beads about the issue a run is correlated to.
 *
 * `bd` is run with an argument array and no shell, and the only id it is given
 * is a `BeadsIssueId`: a value that came out of a validated run correlation.
 * Nothing read from a hook payload can be passed here, by type.
 */

import { execFileSync } from "child_process";
import type { CloseGateIssueType } from "./close-testing-attestation";
import type { BeadsIssueId } from "./run-correlation";

export type ExecFile = (
  file: string,
  args: readonly string[],
  opts?: { cwd?: string },
) => { ok: boolean; output: string };

/**
 * Run a program with its arguments as given: no shell reads them. On Windows
 * that means only a real executable is found; a `.cmd` shim is not run.
 */
export const execFileNoShell: ExecFile = (file, args, opts = {}) => {
  try {
    const output = execFileSync(file, [...args], {
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
