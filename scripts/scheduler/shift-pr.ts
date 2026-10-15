/**
 * The two places a shift reaches its remote: the base it builds every bead
 * on, and the draft pull request of a bead that reached `review`.
 *
 * `fetchBase` fetches one branch from `origin` into its remote-tracking ref
 * and answers the commit it names; the shift pins that commit and starts
 * every worktree there, so a shift run from a feature branch, or from a
 * checkout whose master is behind, builds nothing on stale code.
 *
 * `openDraftPr` is decision 7: a pull request opened with the template,
 * never merged, never pushed to the default branch. In order, each a refusal
 * before the next: the branch must be the bead's own shift branch
 * (`shift/<shift-id>/<bead>`, not the base); it must have commits of its own;
 * its body (the run's, else one the shift writes from the template's
 * sections) must pass `pr:check`; then that one ref is pushed to `origin`
 * (no force, no upstream written to the config) and `gh pr create --draft`
 * opens the pull request. A failure says which step (`kind`) and what git or
 * gh said (`error`, secrets redacted); `PR_FAILURES` holds the fixed sentence
 * for each kind that a bead's comment may carry.
 *
 * git, gh and pr:check are given as functions, so the tests run real git on
 * a scratch repository with a bare origin of its own and a gh that records
 * its arguments. Every process is started with an argument array, never a
 * shell.
 */

import { execFile } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { redactSecrets } from "../secret-patterns";
import { isShiftId } from "./shift-store";

// ── Running a tool ──────────────────────────────────────────────────────────

export interface ToolResult {
  /** Null when the program could not be started or was killed at its limit. */
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Runs a program with an argument array in `cwd`, never through a shell. */
export type ToolRun = (
  args: readonly string[],
  cwd: string,
  timeoutMs?: number,
) => Promise<ToolResult>;

const TOOL_MS = 120_000;

/**
 * The real runner for `git` or `gh`. Neither may stop to ask a person: git
 * is told not to prompt for credentials, gh not to prompt at all.
 */
export function toolRunner(command: "git" | "gh"): ToolRun {
  return (args, cwd, timeoutMs = TOOL_MS) =>
    new Promise((done) => {
      execFile(
        command,
        [...args],
        {
          cwd,
          encoding: "utf8",
          timeout: timeoutMs,
          windowsHide: true,
          maxBuffer: 8 * 1024 * 1024,
          env: {
            ...process.env,
            GIT_TERMINAL_PROMPT: "0",
            GH_PROMPT_DISABLED: "1",
          },
        },
        (error, stdout, stderr) => {
          const code = (error as { code?: unknown } | null)?.code;
          done({
            status: error === null ? 0 : typeof code === "number" ? code : null,
            stdout: stdout ?? "",
            stderr: stderr || (error?.message ?? ""),
          });
        },
      );
    });
}

/** A tool call that answers rather than throws: a runner that threw is a program that never answered. */
async function call(
  run: ToolRun,
  args: readonly string[],
  cwd: string,
  timeoutMs?: number,
): Promise<ToolResult> {
  try {
    return await run(args, cwd, timeoutMs);
  } catch (error) {
    return {
      status: null,
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
    };
  }
}

/** What a tool said, for a record: its output made safe and short. */
function said(result: ToolResult): string {
  const text = (result.stderr || result.stdout).trim();
  const plain =
    text !== ""
      ? text.replace(/\s+/g, " ")
      : result.status === null
        ? "it could not be run, or did not finish in time"
        : `it exited ${result.status}`;
  return redactSecrets(plain).text.slice(0, 300);
}

// ── The base ────────────────────────────────────────────────────────────────

/** The remote every shift fetches its base from and pushes its branches to. */
export const ORIGIN = "origin";

const BRANCH_PART = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * A branch a shift may build on: plain name parts joined by `/`, at most 100
 * characters, nothing git would read as an option or a range, never `HEAD`
 * and never a shift's own branch.
 */
export function isBaseBranch(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 100) return false;
  if (value === "HEAD" || value.startsWith("shift/")) return false;
  if (value.includes("..") || value.endsWith(".lock")) return false;
  return value.split("/").every((part) => BRANCH_PART.test(part));
}

/**
 * Fetch `base` from origin into `refs/remotes/origin/<base>`, in the main
 * checkout, and answer the commit it names. The checkout itself (its HEAD,
 * its branches, its files) is not touched.
 */
export async function fetchBase(
  git: ToolRun,
  main: string,
  base: string,
): Promise<
  | { ok: true; value: { ref: string; sha: string } }
  | { ok: false; error: string }
> {
  if (!isBaseBranch(base))
    return {
      ok: false,
      error: `"${base}" is not a branch a shift may build on`,
    };
  const ref = `refs/remotes/${ORIGIN}/${base}`;
  const fetched = await call(
    git,
    ["fetch", "--no-tags", ORIGIN, `+refs/heads/${base}:${ref}`],
    main,
  );
  if (fetched.status !== 0)
    return {
      ok: false,
      error: `git fetch ${ORIGIN} ${base} failed: ${said(fetched)}`,
    };
  const resolved = await call(
    git,
    ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`],
    main,
    10_000,
  );
  const sha = resolved.stdout.trim();
  if (resolved.status !== 0 || !/^[0-9a-f]{40,64}$/.test(sha))
    return { ok: false, error: `${ref} names no commit after the fetch` };
  return { ok: true, value: { ref, sha } };
}

// ── The pull request ────────────────────────────────────────────────────────

/** Where a run leaves its filled PR body, in its worktree (the ship step's own path). */
export const RUN_PR_BODY = ".tmp/work/pr-body.md";
/** Where the shift writes one when the run left none. */
export const SHIFT_PR_BODY = ".tmp/work/shift-pr-body.md";

/** The sections of `.claude/skills/pr-description/references/pr-template.md`, in its order. */
export const PR_SECTIONS = [
  "What Changed",
  "Why It's Needed",
  "How It Was Tested",
  "Test Evidence",
  "Risk & Rollback",
  "Linked Issues & AC Trace",
] as const;

/** Why no pull request was opened, as a bead's comment may say it: fixed words, nothing a tool printed. */
export const PR_FAILURES = {
  branch:
    "its branch is not the shift's own branch for it, so nothing was pushed",
  "no-commits": "its branch has no commits of its own, so nothing was pushed",
  body: "no PR body passed pr:check, so nothing was pushed",
  push: "the push of its branch to origin failed",
  gh: "gh pr create failed after its branch was pushed",
  url: "gh pr create printed no pull request URL after its branch was pushed",
} as const;

export type PrFailureKind = keyof typeof PR_FAILURES;

export interface PullRequestRequest {
  shiftId: string;
  beadId: string;
  /** The bead's title, for the pull request's. */
  title?: string | undefined;
  runId: string;
  smith?: string | undefined;
  /** Runs made: the first, then each repair. */
  attempts: number;
  branch: string;
  worktree: string;
  /** The branch on origin the pull request goes into. */
  base: string;
  /** The commit the bead's worktree started at. */
  baseSha: string;
}

export interface PullRequestDeps {
  git: ToolRun;
  gh: ToolRun;
  /** `pr:check` on a body file: null when every section is there and filled, else why not. */
  checkPrBody(path: string): Promise<string | null>;
}

export type PullRequestOutcome =
  | { ok: true; url: string; body: "run" | "shift" }
  | {
      ok: false;
      kind: PrFailureKind;
      error: string;
      body?: "run" | "shift";
    };

const fail = (
  kind: PrFailureKind,
  error: string,
  body?: "run" | "shift",
): PullRequestOutcome => ({
  ok: false,
  kind,
  error,
  ...(body !== undefined ? { body } : {}),
});

/** The pull request's title: the bead and its title, on one line. */
export function prTitle(request: PullRequestRequest): string {
  const title = (request.title ?? "").replace(/\s+/g, " ").trim();
  const text =
    title === ""
      ? `${request.beadId} (shift ${request.shiftId})`
      : `${request.beadId}: ${title}`;
  return text.slice(0, 120);
}

/**
 * The body a shift writes when the run left none: the template's sections,
 * each holding only what the shift knows, and saying so. It claims no test
 * evidence and closes nothing.
 */
export function shiftPrBody(
  request: PullRequestRequest,
  commits: readonly string[],
): string {
  const runs = `${request.attempts} run${request.attempts === 1 ? "" : "s"}`;
  const listed = commits.map((line) => `- ${line}`);
  const sections: Record<(typeof PR_SECTIONS)[number], string[]> = {
    "What Changed": [
      `The run of shift ${request.shiftId} for bead ${request.beadId} left no PR body, so the shift wrote this one. The commits on \`${request.branch}\`, from \`${request.baseSha.slice(0, 12)}\` on \`${request.base}\`:`,
      "",
      ...listed,
    ],
    "Why It's Needed": [
      `Bead ${request.beadId}${request.title !== undefined && request.title.trim() !== "" ? `: ${request.title.replace(/\s+/g, " ").trim()}` : ""}. Its description and acceptance criteria are on the bead: \`bd show ${request.beadId}\`.`,
    ],
    "How It Was Tested": [
      `The shift ran the bead through /forgemaster-auto${request.smith !== undefined ? ` with smith ${request.smith}` : ""} (${runs}, run id \`${request.runId}\`). The shift itself ran no tests and records no gate output.`,
    ],
    "Test Evidence": [
      `No test evidence is attached: the run left no PR body. The run's events: \`bun run forge:audit --run ${request.runId}\`.`,
    ],
    "Risk & Rollback": [
      "- Risk level: not assessed by the shift. This pull request is a draft: review it before marking it ready.",
      `- Rollback: close this pull request and delete the branch \`${request.branch}\`; nothing was merged.`,
    ],
    "Linked Issues & AC Trace": [
      `Bead: ${request.beadId} (this pull request does not close it).`,
      "",
      "| Acceptance Criterion | Verified By |",
      "|----------------------|-------------|",
      `| The acceptance criteria of ${request.beadId} | Not traced: the run left no PR body |`,
    ],
  };
  return `${PR_SECTIONS.map((name) => [`## ${name}`, ...sections[name], ""].join("\n")).join("\n")}`;
}

const PR_URL = /^https:\/\/\S+\/pull\/\d+$/;

/**
 * Open the draft pull request of a bead in review. Never merges, never marks
 * it ready, never pushes any branch but the bead's own shift branch, and
 * pushes nothing until the branch and its body have been checked.
 */
export async function openDraftPr(
  request: PullRequestRequest,
  deps: PullRequestDeps,
): Promise<PullRequestOutcome> {
  const { branch, worktree, base } = request;
  if (
    !isShiftId(request.shiftId) ||
    branch !== `shift/${request.shiftId}/${request.beadId}` ||
    branch === base ||
    !isBaseBranch(base)
  )
    return fail(
      "branch",
      `${branch} is not shift/${request.shiftId}/${request.beadId}, or is the base ${base}`,
    );

  const log = await call(
    deps.git,
    [
      "log",
      "--format=%h %s",
      "--max-count=50",
      `${request.baseSha}..refs/heads/${branch}`,
      "--",
    ],
    worktree,
    10_000,
  );
  if (log.status !== 0)
    return fail("branch", `git log of ${branch} failed: ${said(log)}`);
  const commits = log.stdout.split(/\r?\n/).filter((line) => line !== "");
  if (commits.length === 0)
    return fail(
      "no-commits",
      `${branch} has no commits after ${request.baseSha}`,
    );

  const runBody = join(worktree, RUN_PR_BODY);
  const from: "run" | "shift" = existsSync(runBody) ? "run" : "shift";
  const body = from === "run" ? runBody : join(worktree, SHIFT_PR_BODY);
  if (from === "shift")
    try {
      mkdirSync(dirname(body), { recursive: true });
      writeFileSync(body, shiftPrBody(request, commits));
    } catch (error) {
      return fail(
        "body",
        `the shift's PR body could not be written: ${error instanceof Error ? error.message : String(error)}`,
        from,
      );
    }
  let unchecked: string | null;
  try {
    unchecked = await deps.checkPrBody(body);
  } catch (error) {
    unchecked = `pr:check could not be run: ${error instanceof Error ? error.message : String(error)}`;
  }
  if (unchecked !== null)
    return fail("body", redactSecrets(unchecked).text.slice(0, 300), from);

  const pushed = await call(
    deps.git,
    [
      "push",
      "--porcelain",
      ORIGIN,
      `refs/heads/${branch}:refs/heads/${branch}`,
    ],
    worktree,
  );
  if (pushed.status !== 0)
    return fail(
      "push",
      `git push ${ORIGIN} ${branch} failed: ${said(pushed)}`,
      from,
    );

  const opened = await call(
    deps.gh,
    [
      "pr",
      "create",
      "--draft",
      `--base=${base}`,
      `--head=${branch}`,
      `--title=${prTitle(request)}`,
      `--body-file=${body}`,
    ],
    worktree,
  );
  if (opened.status !== 0)
    return fail("gh", `gh pr create failed: ${said(opened)}`, from);
  const url = opened.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .reverse()
    .find((line) => PR_URL.test(line));
  if (url === undefined)
    return fail(
      "url",
      `gh pr create printed no pull request URL: ${said(opened)}`,
      from,
    );
  return { ok: true, url, body: from };
}

// ── pr:check ────────────────────────────────────────────────────────────────

/**
 * The real `pr:check`: `bun run pr:check <file>` in the harness checkout
 * that holds the validator. Null when it says the body is whole.
 */
export function prCheckRunner(
  harnessRoot: string,
): (path: string) => Promise<string | null> {
  return (path) =>
    new Promise((done) => {
      execFile(
        process.execPath,
        ["run", "pr:check", path],
        {
          cwd: harnessRoot,
          encoding: "utf8",
          timeout: 60_000,
          windowsHide: true,
        },
        (error, stdout) => {
          let answer: { ok?: unknown; error?: unknown } | null = null;
          try {
            answer = JSON.parse(stdout) as { ok?: unknown; error?: unknown };
          } catch {
            answer = null;
          }
          if (error === null && answer?.ok === true) return done(null);
          done(
            typeof answer?.error === "string"
              ? `pr:check: ${answer.error}`
              : `pr:check failed: ${error?.message ?? "it printed no answer"}`,
          );
        },
      );
    });
}
