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
 * (`shift/<shift-id>/<bead>`, not the base); the worktree must be the
 * directory the registry made (`<main>/trees/<id>`, not a link); the branch
 * must have commits of its own; the body (the run's, read once from a file
 * of the worktree's own, else one the shift writes from the template's
 * sections) must hold nothing that looks like a secret, and is copied to a
 * fresh file in the shift's own directory, which is the one file `pr:check`
 * reads and gh posts; then that one ref is pushed to `origin` (no force, no
 * tags, no upstream written to the config) and `gh pr create --draft` opens
 * the pull request. A failure says which step (`kind`) and why (`error`,
 * secrets redacted); `PR_FAILURES` holds the fixed sentence for each kind
 * that a bead's comment may carry.
 *
 * git, gh and pr:check are given as functions, so the tests run real git on
 * a scratch repository with a bare origin of its own and a gh that records
 * its arguments. Every process is started with an argument array, never a
 * shell.
 */

import { execFile } from "node:child_process";
import {
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { isBeadId } from "../hearth/tracker-write";
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

/** The largest body the shift reads; gh itself takes far less. */
const MAX_BODY_BYTES = 1_000_000;

/** What `createWorktree` names a worktree: its directory under `trees/`. */
const WORKTREE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;

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
  worktree:
    "its worktree is not the directory the shift made for it, so nothing was pushed",
  "no-commits": "its branch has no commits of its own, so nothing was pushed",
  body: "no PR body could be used (a link, what looks like a secret, or pr:check refused it), so nothing was pushed",
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
  /** `<mainCheckout>/trees/<worktreeId>`, as the registry made it. */
  worktree: string;
  mainCheckout: string;
  worktreeId: string;
  /**
   * The shift's own directory, outside every worktree: the body that is
   * checked and posted is a copy written here, fresh for each attempt.
   */
  bodyDir: string;
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

/** Whether `path` (which need not exist yet) lies inside `root`, once every link on the way is followed. */
function realInside(root: string, path: string): boolean {
  let existing = path;
  const rest: string[] = [];
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) return false;
    rest.unshift(basename(existing));
    existing = parent;
  }
  let real: string;
  try {
    real = realpathSync.native(existing);
  } catch {
    return false;
  }
  const rel = relative(root, join(real, ...rest));
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * The worktree's real path, when it is the directory the registry made:
 * `<mainCheckout>/trees/<worktreeId>` itself, not a link, and leading
 * nowhere else. Else why not.
 */
function shiftWorktree(request: PullRequestRequest): { root: string } | string {
  if (!WORKTREE_ID.test(request.worktreeId)) return "has no worktree id";
  let main: string;
  let root: string;
  try {
    const stat = lstatSync(request.worktree);
    if (stat.isSymbolicLink() || !stat.isDirectory())
      return `${request.worktree} is a link, or not a directory`;
    main = realpathSync.native(request.mainCheckout);
    root = realpathSync.native(request.worktree);
  } catch {
    return `${request.worktree} cannot be read`;
  }
  return relative(join(main, "trees", request.worktreeId), root) === ""
    ? { root }
    : `${request.worktree} is not ${join(main, "trees", request.worktreeId)}`;
}

/**
 * The text of `path` when it is a file of the worktree's own (`root`, its
 * real path), read once: absent, or a plain file with one name whose real
 * path is inside the worktree, and the file opened is the one checked (same
 * device and file id). A symbolic link, a hard link, a path that leads out
 * of the worktree, or a file swapped between the check and the open is
 * refused, with why.
 */
function readOwnFile(
  root: string,
  path: string,
): { present: false } | { present: true; text: string } | string {
  if (!realInside(root, dirname(path))) return "is outside the worktree";
  let checked: ReturnType<typeof lstatSync>;
  try {
    checked = lstatSync(path, { bigint: true });
  } catch (error) {
    return (error as { code?: unknown }).code === "ENOENT"
      ? { present: false }
      : "cannot be read";
  }
  if (checked.isSymbolicLink()) return "is a symbolic link";
  if (!checked.isFile()) return "is not a file";
  if (checked.nlink > 1n)
    return `is a hard link (it has ${checked.nlink} names)`;
  if (!realInside(root, path)) return "is outside the worktree";
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return "cannot be opened";
  }
  try {
    const opened = fstatSync(fd, { bigint: true });
    if (
      opened.dev !== checked.dev ||
      opened.ino !== checked.ino ||
      opened.nlink > 1n ||
      !opened.isFile()
    )
      return "changed between the check and the read";
    if (opened.size > BigInt(MAX_BODY_BYTES))
      return `is larger than ${MAX_BODY_BYTES} bytes`;
    return { present: true, text: readFileSync(fd, "utf8") };
  } catch {
    return "cannot be read";
  } finally {
    closeSync(fd);
  }
}

/**
 * Write the body the shift will check and post to a fresh file of its own,
 * outside every worktree: a new directory under `bodyDir` (`mkdtemp`), and
 * the file in it made with `wx`. The path, or why not.
 */
function keepBody(
  request: PullRequestRequest,
  text: string,
): { path: string } | string {
  try {
    mkdirSync(request.bodyDir, { recursive: true });
    const dir = mkdtempSync(join(request.bodyDir, `${request.beadId}-`));
    const path = join(dir, "pr-body.md");
    writeFileSync(path, text, { flag: "wx" });
    return { path };
  } catch (error) {
    return `the body could not be kept in ${request.bodyDir} (${(error as { code?: unknown }).code ?? "unknown error"})`;
  }
}

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
    !isBeadId(request.beadId) ||
    branch !== `shift/${request.shiftId}/${request.beadId}` ||
    branch === base ||
    !isBaseBranch(base)
  )
    return fail(
      "branch",
      `${branch} is not shift/${request.shiftId}/${request.beadId}, or is the base ${base}`,
    );
  // Before git runs in it or anything is read from it.
  const made = shiftWorktree(request);
  if (typeof made === "string") return fail("worktree", made);
  const { root } = made;

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

  // The body is read once, here. What is checked and posted from now on is
  // the shift's own copy outside the worktree, so nothing done to the
  // worktree afterwards (a junction swapped in by a leftover process) can
  // change it.
  const runFile = readOwnFile(root, join(worktree, RUN_PR_BODY));
  if (typeof runFile === "string")
    return fail("body", `${RUN_PR_BODY} ${runFile}; it is not used`, "run");
  const from: "run" | "shift" = runFile.present ? "run" : "shift";
  const text = runFile.present ? runFile.text : shiftPrBody(request, commits);
  // The repository is public: a body or title that looks like it holds a
  // secret is not copied, pushed or posted, and the refusal names only kinds.
  const secrets = redactSecrets(`${prTitle(request)}\n${text}`).redactions;
  if (secrets.length > 0)
    return fail(
      "body",
      `the PR title or body holds what looks like a secret (${secrets.map((found) => found.kind).join(", ")}); nothing was copied or pushed`,
      from,
    );
  const kept = keepBody(request, text);
  if (typeof kept === "string") return fail("body", kept, from);
  const body = kept.path;
  let unchecked: string | null;
  try {
    unchecked = await deps.checkPrBody(body);
  } catch (error) {
    unchecked = `pr:check could not be run: ${error instanceof Error ? error.message : String(error)}`;
  }
  if (unchecked !== null)
    return fail("body", redactSecrets(unchecked).text.slice(0, 300), from);

  // The one ref, named in full on the command line, so that no remote.*.push
  // refspec applies; no tags, whatever push.followTags says; no submodules.
  const pushed = await call(
    deps.git,
    [
      "push",
      "--porcelain",
      "--no-follow-tags",
      "--recurse-submodules=no",
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
