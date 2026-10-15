import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  fetchBase,
  isBaseBranch,
  openDraftPr,
  PR_FAILURES,
  PR_SECTIONS,
  type PullRequestDeps,
  type PullRequestRequest,
  prCheckRunner,
  RUN_PR_BODY,
  type ToolRun,
  toolRunner,
} from "./shift-pr";
import { createWorktree } from "./worktrees";

/**
 * The pull request step against real git: a scratch repository whose origin
 * is a bare repository of its own in the OS temp dir, never the real remote.
 * gh is always a function that records what it was asked and answers as
 * the test says; no test runs the real gh. pr:check is the real one.
 */

setDefaultTimeout(60_000);

/** Where the shift once wrote its own body in the worktree; it no longer writes there. */
const SHIFT_PR_BODY = ".tmp/work/shift-pr-body.md";

const REPO = resolve(import.meta.dir, "..", "..");
const roots: string[] = [];
afterAll(() => {
  for (const root of roots)
    rmSync(root, { recursive: true, force: true, maxRetries: 5 });
});

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0)
    throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

function identity(dir: string): void {
  git(dir, "config", "user.email", "shift@example.invalid");
  git(dir, "config", "user.name", "shift pr test");
  git(dir, "config", "commit.gpgsign", "false");
}

function commit(dir: string, file: string, message: string): string {
  writeFileSync(join(dir, file), `${message}\n`);
  git(dir, "add", "--", file);
  git(dir, "commit", "-q", "-m", message);
  return git(dir, "rev-parse", "HEAD");
}

interface Scratch {
  /** The temp directory everything is in: outside the checkout and its worktrees. */
  root: string;
  origin: string;
  main: string;
  /** origin's master, which the checkout has not fetched. */
  originSha: string;
  /** The shift's own directory in its home, where it keeps the bodies it checks and posts. */
  bodies: string;
}

/**
 * A checkout on a feature branch of its own, whose origin (a bare repository
 * beside it) moved on after the checkout last fetched: neither its HEAD nor
 * its master is origin's master.
 */
function scratch(): Scratch {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "pr ")));
  roots.push(root);
  const origin = join(root, "origin.git");
  git(root, "init", "-q", "--bare", "-b", "master", origin);
  const main = join(root, "main repo");
  mkdirSync(main);
  git(main, "init", "-q", "-b", "master");
  identity(main);
  writeFileSync(join(main, ".gitignore"), "trees/\n.tmp/\n");
  commit(main, "README.md", "start");
  git(main, "remote", "add", "origin", origin);
  git(main, "push", "-q", "origin", "master");
  const other = join(root, "other clone");
  git(root, "clone", "-q", origin, other);
  identity(other);
  const originSha = commit(other, "upstream.txt", "on origin only");
  git(other, "push", "-q", "origin", "master");
  git(main, "checkout", "-q", "-b", "feature");
  commit(main, "feature.txt", "feature only");
  return {
    root,
    origin,
    main,
    originSha,
    bodies: join(root, "forge home", "shifts", SHIFT),
  };
}

const SHIFT = "shift-20261014-120000-0a0b";
let worktrees = 0;

/** The bead's worktree as a shift makes it: its branch from origin's master, with the run's commits. */
function beadWorktree(
  s: Scratch,
  beadId = "t-1",
  commits = 1,
): PullRequestRequest {
  const branch = `shift/${SHIFT}/${beadId}`;
  // As the shift does before it makes any worktree.
  git(s.main, "fetch", "-q", "origin");
  const worktreeId = `${SHIFT}-${++worktrees}`;
  const made = createWorktree(
    s.main,
    s.main,
    { branch, beadId, startPoint: s.originSha },
    { newId: () => worktreeId },
  );
  if (!made.ok) throw new Error(made.error);
  const worktree = made.value.path;
  identity(worktree);
  for (let n = 1; n <= commits; n++)
    commit(worktree, `work-${n}.txt`, `the run's commit ${n}`);
  return {
    shiftId: SHIFT,
    beadId,
    title: "Add the widget",
    runId: `${beadId}-${SHIFT}`,
    smith: "claude-master",
    attempts: 1,
    branch,
    worktree,
    mainCheckout: s.main,
    worktreeId,
    bodyDir: s.bodies,
    base: "master",
    baseSha: s.originSha,
  };
}

/** The --body-file gh was given, and what it holds now. */
function postedBody(call: Called | undefined): { path: string; text: string } {
  const path =
    call?.args
      .find((arg) => arg.startsWith("--body-file="))
      ?.slice("--body-file=".length) ?? "";
  let text = "";
  try {
    text = path === "" ? "" : readFileSync(path, "utf8");
  } catch {
    text = "";
  }
  return { path, text };
}

/** Whether `path` is inside `dir`. */
const under = (dir: string, path: string): boolean =>
  realpathSync.native(path).startsWith(`${realpathSync.native(dir)}\\`) ||
  realpathSync.native(path).startsWith(`${realpathSync.native(dir)}/`);

const FILLED = [
  "## What Changed",
  "- Added the widget.",
  "## Why It's Needed",
  "The widget was missing.",
  "## How It Was Tested",
  "- bun test",
  "## Test Evidence",
  "```",
  "1 pass",
  "```",
  "## Risk & Rollback",
  "- Risk level: Low, one new file.",
  "## Linked Issues & AC Trace",
  "Closes: t-1",
  "",
].join("\n");

function leaveBody(worktree: string, text = FILLED): string {
  const path = join(worktree, RUN_PR_BODY);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  return path;
}

interface Called {
  args: string[];
  cwd: string;
}

/** A gh that records what it was asked and answers as told. */
function fakeGh(
  answer: (args: string[]) => {
    status: number | null;
    stdout: string;
    stderr: string;
  } = () => ({
    status: 0,
    stdout: "https://github.com/example/harness/pull/7\n",
    stderr: "",
  }),
) {
  const calls: Called[] = [];
  /** The body each call posted, read when gh was asked, as the real gh reads it. */
  const posted: string[] = [];
  const run: ToolRun = async (args, cwd) => {
    calls.push({ args: [...args], cwd });
    posted.push(postedBody({ args: [...args], cwd }).text);
    return answer([...args]);
  };
  return { calls, posted, run };
}

/** Real git, every call recorded. */
function recordedGit() {
  const calls: Called[] = [];
  const real = toolRunner("git");
  const run: ToolRun = (args, cwd, timeoutMs) => {
    calls.push({ args: [...args], cwd });
    return real(args, cwd, timeoutMs);
  };
  return { calls, run };
}

const remoteBranches = (origin: string): string[] =>
  git(origin, "for-each-ref", "--format=%(refname)", "refs/heads")
    .split("\n")
    .filter((line) => line !== "")
    .sort();

/** Every ref origin has, tags included. */
const remoteRefs = (origin: string): string[] =>
  git(origin, "for-each-ref", "--format=%(refname)")
    .split("\n")
    .filter((line) => line !== "")
    .sort();

/**
 * Whether this process may make a file symbolic link. On Windows it needs a
 * privilege (or developer mode) that this machine's test runs do not have;
 * junctions and hard links need none, so those cases always run.
 */
const canSymlinkFiles = (() => {
  const dir = mkdtempSync(join(tmpdir(), "ln "));
  try {
    writeFileSync(join(dir, "target"), "x");
    symlinkSync(join(dir, "target"), join(dir, "link"), "file");
    return true;
  } catch {
    return false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();

/** A pr:check that records which files it was asked about and passes them. */
function recordedCheck() {
  const paths: string[] = [];
  return {
    paths,
    run: async (path: string): Promise<string | null> => {
      paths.push(path);
      return null;
    },
  };
}

describe("isBaseBranch", () => {
  test("a plain branch name, never a shift branch or one that reads as an option", () => {
    for (const name of ["master", "main", "release/2.1", "team_x/feature-y"])
      expect({ name, ok: isBaseBranch(name) }).toEqual({ name, ok: true });
    for (const name of [
      "",
      "-x",
      "--all",
      "shift/shift-20261014-120000-0a0b/t-1",
      "shift/x",
      "a..b",
      "a b",
      "a//b",
      "/a",
      "a/",
      "a.lock",
      "HEAD",
      "two\nlines",
      "x".repeat(101),
    ])
      expect({ name, ok: isBaseBranch(name) }).toEqual({ name, ok: false });
  });
});

describe("fetchBase", () => {
  test("fetches the base from origin and answers its newest commit: not the checkout's HEAD, nor its stale master", async () => {
    const s = scratch();
    const before = git(s.main, "rev-parse", "master");
    const fetched = await fetchBase(toolRunner("git"), s.main, "master");
    expect(fetched).toEqual({
      ok: true,
      value: { ref: "refs/remotes/origin/master", sha: s.originSha },
    });
    expect(git(s.main, "rev-parse", "refs/remotes/origin/master")).toBe(
      s.originSha,
    );
    expect(git(s.main, "rev-parse", "HEAD")).not.toBe(s.originSha);
    expect(before).not.toBe(s.originSha);
    // The checkout itself was not moved.
    expect(git(s.main, "rev-parse", "--abbrev-ref", "HEAD")).toBe("feature");
  });

  test("a base origin does not have, a checkout with no origin, and a name that is not a base are refused", async () => {
    const s = scratch();
    const missing = await fetchBase(toolRunner("git"), s.main, "no-such");
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error).toContain("git fetch");
    git(s.main, "remote", "remove", "origin");
    const noOrigin = await fetchBase(toolRunner("git"), s.main, "master");
    expect(noOrigin.ok).toBe(false);
    const calls = recordedGit();
    const bad = await fetchBase(calls.run, s.main, "--upload-pack=evil");
    expect(bad.ok).toBe(false);
    expect(calls.calls).toEqual([]);
  });
});

describe("openDraftPr", () => {
  test("pushes only the bead's shift branch to origin and opens a draft pull request with the run's body; nothing else on origin changes", async () => {
    const s = scratch();
    const request = beadWorktree(s, "t-1", 2);
    leaveBody(request.worktree);
    const gh = fakeGh();
    const opened = await openDraftPr(request, {
      git: toolRunner("git"),
      gh: gh.run,
      checkPrBody: prCheckRunner(REPO),
    });
    expect(opened).toEqual({
      ok: true,
      url: "https://github.com/example/harness/pull/7",
      body: "run",
    });
    expect(remoteBranches(s.origin)).toEqual([
      "refs/heads/master",
      `refs/heads/${request.branch}`,
    ]);
    expect(git(s.origin, "rev-parse", "master")).toBe(s.originSha);
    expect(git(s.origin, "rev-parse", request.branch)).toBe(
      git(request.worktree, "rev-parse", "HEAD"),
    );
    // The branch was built on origin's master.
    expect(git(s.origin, "merge-base", "master", request.branch)).toBe(
      s.originSha,
    );
    // gh is given the run's body as it was read: a copy in the shift's own
    // directory, outside the worktree.
    const posted = postedBody(gh.calls[0]);
    expect(under(s.bodies, posted.path)).toBe(true);
    expect(posted.text).toBe(FILLED);
    expect(gh.posted).toEqual([FILLED]);
    expect(gh.calls).toEqual([
      {
        args: [
          "pr",
          "create",
          "--draft",
          "--base=master",
          `--head=${request.branch}`,
          "--title=t-1: Add the widget",
          `--body-file=${posted.path}`,
        ],
        cwd: request.worktree,
      },
    ]);
    // No upstream was written to the shared config.
    expect(
      spawnSync("git", ["config", "--get", `branch.${request.branch}.remote`], {
        cwd: s.main,
        encoding: "utf8",
      }).stdout,
    ).toBe("");
  });

  test("when the run left no body, the shift writes one with the template's six sections, in its own directory and not in the worktree; it passes the real pr:check and is the body gh is given", async () => {
    const s = scratch();
    const request = beadWorktree(s, "t-2", 1);
    const gh = fakeGh();
    const opened = await openDraftPr(request, {
      git: toolRunner("git"),
      gh: gh.run,
      checkPrBody: prCheckRunner(REPO),
    });
    expect(opened).toMatchObject({ ok: true, body: "shift" });
    const { path, text } = postedBody(gh.calls[0]);
    expect(under(s.bodies, path)).toBe(true);
    expect(existsSync(join(request.worktree, SHIFT_PR_BODY))).toBe(false);
    expect(existsSync(join(request.worktree, RUN_PR_BODY))).toBe(false);
    const headings = (markdown: string) =>
      [...markdown.matchAll(/^## (.+?)\s*$/gm)].map((match) => match[1]);
    // The six sections, in the template's order and words.
    const template = readFileSync(
      join(
        REPO,
        ".claude",
        "skills",
        "pr-description",
        "references",
        "pr-template.md",
      ),
      "utf8",
    );
    expect(headings(text)).toEqual(headings(template));
    expect(headings(text)).toEqual([...PR_SECTIONS]);
    // It says what it is, and claims no evidence.
    expect(text).toContain("left no PR body");
    expect(text).toContain("No test evidence is attached");
    expect(text).toContain("the run's commit 1");
    expect(text).toContain(`bun run forge:audit --run ${request.runId}`);
    expect(text).not.toContain("Closes");
    expect(await prCheckRunner(REPO)(path)).toBeNull();
  });

  test("a branch that is not this bead's shift branch is never pushed: the base, another bead's, another shift's, a feature branch", async () => {
    const s = scratch();
    const request = beadWorktree(s, "t-3", 1);
    leaveBody(request.worktree);
    for (const branch of [
      "master",
      "feature",
      `shift/${SHIFT}/t-other`,
      "shift/shift-20261014-130000-0c0d/t-3",
      `shift/${SHIFT}/t-3/more`,
    ]) {
      const git = recordedGit();
      const gh = fakeGh();
      const refused = await openDraftPr(
        { ...request, branch },
        { git: git.run, gh: gh.run, checkPrBody: async () => null },
      );
      expect({ branch, refused }).toMatchObject({
        branch,
        refused: { ok: false, kind: "branch" },
      });
      expect(git.calls).toEqual([]);
      expect(gh.calls).toEqual([]);
    }
    // And a base that is the branch itself.
    const git = recordedGit();
    const same = await openDraftPr(
      { ...request, base: request.branch },
      { git: git.run, gh: fakeGh().run, checkPrBody: async () => null },
    );
    expect(same).toMatchObject({ ok: false, kind: "branch" });
    expect(git.calls).toEqual([]);
    expect(remoteBranches(s.origin)).toEqual(["refs/heads/master"]);
  });

  test("a branch with no commits of its own, and a body that fails pr:check, are not pushed and open nothing", async () => {
    const s = scratch();
    const empty = beadWorktree(s, "t-4", 0);
    leaveBody(empty.worktree);
    const gh = fakeGh();
    const git = recordedGit();
    const deps: PullRequestDeps = {
      git: git.run,
      gh: gh.run,
      checkPrBody: prCheckRunner(REPO),
    };
    expect(await openDraftPr(empty, deps)).toMatchObject({
      ok: false,
      kind: "no-commits",
    });

    const thin = { ...beadWorktree(s, "t-5", 1) };
    leaveBody(thin.worktree, "## What Changed\n- something\n");
    const refused = await openDraftPr(thin, deps);
    expect(refused).toMatchObject({ ok: false, kind: "body", body: "run" });
    if (!refused.ok) expect(refused.error).toContain("missing sections");
    expect(git.calls.some((call) => call.args[0] === "push")).toBe(false);
    expect(gh.calls).toEqual([]);
    expect(remoteBranches(s.origin)).toEqual(["refs/heads/master"]);
  });

  test("a push origin refuses is a push failure: gh is not asked; gh that fails or prints no URL is its own failure, its words redacted", async () => {
    const s = scratch();
    const request = beadWorktree(s, "t-6", 1);
    leaveBody(request.worktree);
    const missing = join(s.origin, "..", "gone.git");
    git(s.main, "remote", "set-url", "origin", missing);
    const gh = fakeGh();
    const pushed = await openDraftPr(request, {
      git: toolRunner("git"),
      gh: gh.run,
      checkPrBody: async () => null,
    });
    expect(pushed).toMatchObject({ ok: false, kind: "push" });
    expect(gh.calls).toEqual([]);
    git(s.main, "remote", "set-url", "origin", s.origin);

    const token = `ghp_${"a1B2c3D4e5".repeat(4)}`;
    const failing = fakeGh(() => ({
      status: 1,
      stdout: "",
      stderr: `GraphQL: could not create, token ${token}\n`,
    }));
    const ghFailed = await openDraftPr(request, {
      git: toolRunner("git"),
      gh: failing.run,
      checkPrBody: async () => null,
    });
    expect(ghFailed).toMatchObject({ ok: false, kind: "gh" });
    if (!ghFailed.ok) {
      expect(ghFailed.error).toContain("GraphQL: could not create");
      expect(ghFailed.error).not.toContain(token);
    }
    const silent = fakeGh(() => ({ status: 0, stdout: "done\n", stderr: "" }));
    expect(
      await openDraftPr(request, {
        git: toolRunner("git"),
        gh: silent.run,
        checkPrBody: async () => null,
      }),
    ).toMatchObject({ ok: false, kind: "url" });
  });

  test("a push carries the shift branch only: a tag the run made is not pushed even when the repository's config says push.followTags", async () => {
    const s = scratch();
    git(s.main, "config", "push.followTags", "true");
    const request = beadWorktree(s, "t-7", 1);
    git(request.worktree, "config", "tag.gpgsign", "false");
    git(request.worktree, "tag", "-a", "v9.9.9", "-m", "the run's release tag");
    leaveBody(request.worktree);
    const opened = await openDraftPr(request, {
      git: toolRunner("git"),
      gh: fakeGh().run,
      checkPrBody: async () => null,
    });
    expect(opened).toMatchObject({ ok: true });
    expect(remoteRefs(s.origin)).toEqual([
      "refs/heads/master",
      `refs/heads/${request.branch}`,
    ]);
  });

  test("a bead id that is not one is refused before git is asked anything, even when the branch is built from it", async () => {
    const s = scratch();
    const request = beadWorktree(s, "t-8", 1);
    leaveBody(request.worktree);
    for (const beadId of [
      "a:refs/heads/master",
      "x/../../master",
      "a@{u}",
      "-x",
      "a b",
      "a~1",
      "a^",
      "",
    ]) {
      const git = recordedGit();
      const gh = fakeGh();
      const refused = await openDraftPr(
        { ...request, beadId, branch: `shift/${SHIFT}/${beadId}` },
        { git: git.run, gh: gh.run, checkPrBody: async () => null },
      );
      expect({ beadId, refused }).toMatchObject({
        beadId,
        refused: { ok: false, kind: "branch" },
      });
      expect(git.calls).toEqual([]);
      expect(gh.calls).toEqual([]);
    }
    expect(remoteRefs(s.origin)).toEqual(["refs/heads/master"]);
  });
});

describe("openDraftPr — a body reached through a link is never used or written", () => {
  /** What must not happen when the body is refused: nothing checked, pushed or opened. */
  async function refusedOutright(
    s: Scratch,
    request: PullRequestRequest,
    reason: RegExp,
  ) {
    const git = recordedGit();
    const gh = fakeGh();
    const check = recordedCheck();
    const refused = await openDraftPr(request, {
      git: git.run,
      gh: gh.run,
      checkPrBody: check.run,
    });
    expect(refused).toMatchObject({ ok: false, kind: "body" });
    if (!refused.ok) expect(refused.error).toMatch(reason);
    expect(check.paths).toEqual([]);
    expect(git.calls.some((call) => call.args[0] === "push")).toBe(false);
    expect(gh.calls).toEqual([]);
    expect(remoteRefs(s.origin)).toEqual(["refs/heads/master"]);
  }

  test("the run's body in a directory elsewhere, reached through .tmp/work as a junction, is not checked or posted", async () => {
    const s = scratch();
    const request = beadWorktree(s, "t-j1", 1);
    const elsewhere = join(s.origin, "..", "elsewhere one");
    mkdirSync(elsewhere);
    writeFileSync(join(elsewhere, "pr-body.md"), FILLED);
    mkdirSync(join(request.worktree, ".tmp"), { recursive: true });
    symlinkSync(elsewhere, join(request.worktree, ".tmp", "work"), "junction");
    await refusedOutright(s, request, /outside the worktree/);
  });

  test("with no run body and .tmp/work a junction to a directory elsewhere, the shift writes nothing there", async () => {
    const s = scratch();
    const request = beadWorktree(s, "t-j2", 1);
    const elsewhere = join(s.origin, "..", "elsewhere two");
    mkdirSync(elsewhere);
    mkdirSync(join(request.worktree, ".tmp"), { recursive: true });
    symlinkSync(elsewhere, join(request.worktree, ".tmp", "work"), "junction");
    await refusedOutright(s, request, /outside the worktree/);
    expect(existsSync(join(elsewhere, "shift-pr-body.md"))).toBe(false);
  });

  test("a run body that is a hard link to a file elsewhere is not checked or posted", async () => {
    const s = scratch();
    const request = beadWorktree(s, "t-h1", 1);
    const elsewhere = join(s.origin, "..", "elsewhere body.md");
    writeFileSync(elsewhere, FILLED);
    mkdirSync(join(request.worktree, ".tmp", "work"), { recursive: true });
    linkSync(elsewhere, join(request.worktree, RUN_PR_BODY));
    await refusedOutright(s, request, /link/);
  });

  test("a shift-pr-body.md left in the worktree, even as a hard link to a file elsewhere, is never written: the shift writes its body only in its own directory", async () => {
    const s = scratch();
    const request = beadWorktree(s, "t-h2", 1);
    const victim = join(s.origin, "..", "victim.txt");
    writeFileSync(victim, "ORIGINAL CONTENT\n");
    mkdirSync(join(request.worktree, ".tmp", "work"), { recursive: true });
    linkSync(victim, join(request.worktree, SHIFT_PR_BODY));
    const gh = fakeGh();
    const opened = await openDraftPr(request, {
      git: toolRunner("git"),
      gh: gh.run,
      checkPrBody: prCheckRunner(REPO),
    });
    expect(opened).toMatchObject({ ok: true, body: "shift" });
    expect(readFileSync(victim, "utf8")).toBe("ORIGINAL CONTENT\n");
    expect(under(s.bodies, postedBody(gh.calls[0]).path)).toBe(true);
    expect(gh.posted[0]).toContain("left no PR body");
  });

  // A file symbolic link needs a privilege on Windows that these test runs do not have.
  test.skipIf(!canSymlinkFiles)(
    "a run body that is a symbolic link to a file elsewhere is not checked or posted",
    async () => {
      const s = scratch();
      const request = beadWorktree(s, "t-s1", 1);
      const elsewhere = join(s.origin, "..", "elsewhere linked.md");
      writeFileSync(elsewhere, FILLED);
      mkdirSync(join(request.worktree, ".tmp", "work"), { recursive: true });
      symlinkSync(elsewhere, join(request.worktree, RUN_PR_BODY), "file");
      await refusedOutright(s, request, /link/);
    },
  );
});

describe("openDraftPr — what pr:check passed is what gh posts, and nothing from outside the worktree or holding a secret", () => {
  /** Put a junction at `.tmp/work` to a directory elsewhere holding its own body, keeping the real one aside. */
  function swapWorkForJunction(s: Scratch, worktree: string): void {
    const elsewhere = join(
      s.root,
      `elsewhere ${Math.random().toString(16).slice(2, 8)}`,
    );
    mkdirSync(elsewhere);
    writeFileSync(
      join(elsewhere, "pr-body.md"),
      FILLED.replace("Added the widget.", "OUTSIDE BODY"),
    );
    renameSync(
      join(worktree, ".tmp", "work"),
      join(worktree, ".tmp", "work-was"),
    );
    symlinkSync(elsewhere, join(worktree, ".tmp", "work"), "junction");
  }

  test("a swap of .tmp/work for a junction after pr:check answered changes nothing: gh posts the very text pr:check passed, from the shift's own copy", async () => {
    const s = scratch();
    const request = beadWorktree(s, "t-w1", 1);
    leaveBody(request.worktree);
    const checked: Array<{ path: string; text: string }> = [];
    const gh = fakeGh();
    const opened = await openDraftPr(request, {
      git: toolRunner("git"),
      gh: gh.run,
      checkPrBody: async (path) => {
        checked.push({ path, text: readFileSync(path, "utf8") });
        swapWorkForJunction(s, request.worktree);
        return null;
      },
    });
    expect(opened).toMatchObject({ ok: true, body: "run" });
    expect(checked).toHaveLength(1);
    expect(checked[0]?.text).toBe(FILLED);
    expect(under(s.bodies, checked[0]?.path ?? "")).toBe(true);
    expect(postedBody(gh.calls[0]).path).toBe(checked[0]?.path ?? "");
    expect(gh.posted).toEqual([FILLED]);
  });

  test("a swap of .tmp/work for a junction while the branch is pushed changes nothing either", async () => {
    const s = scratch();
    const request = beadWorktree(s, "t-w2", 1);
    leaveBody(request.worktree);
    const real = toolRunner("git");
    const gh = fakeGh();
    const opened = await openDraftPr(request, {
      git: async (args, cwd, timeoutMs) => {
        if (args[0] === "push") swapWorkForJunction(s, request.worktree);
        return real(args, cwd, timeoutMs);
      },
      gh: gh.run,
      checkPrBody: prCheckRunner(REPO),
    });
    expect(opened).toMatchObject({ ok: true, body: "run" });
    expect(gh.posted).toEqual([FILLED]);
    expect(gh.posted[0]).not.toContain("OUTSIDE BODY");
  });

  test("a worktree directory replaced by a junction to a directory elsewhere (a copy of its .git file and a body) is not the shift's worktree: nothing is read, pushed or opened", async () => {
    const s = scratch();
    const request = beadWorktree(s, "t-w3", 1);
    leaveBody(request.worktree);
    const elsewhere = join(s.root, "elsewhere worktree");
    mkdirSync(join(elsewhere, ".tmp", "work"), { recursive: true });
    writeFileSync(
      join(elsewhere, ".git"),
      readFileSync(join(request.worktree, ".git"), "utf8"),
    );
    writeFileSync(
      join(elsewhere, RUN_PR_BODY),
      FILLED.replace("Added the widget.", "OUTSIDE BODY"),
    );
    renameSync(request.worktree, `${request.worktree}-kept`);
    symlinkSync(elsewhere, request.worktree, "junction");
    const git = recordedGit();
    const gh = fakeGh();
    const check = recordedCheck();
    const refused = await openDraftPr(request, {
      git: git.run,
      gh: gh.run,
      checkPrBody: check.run,
    });
    expect(refused).toMatchObject({ ok: false, kind: "worktree" });
    expect(git.calls).toEqual([]);
    expect(check.paths).toEqual([]);
    expect(gh.calls).toEqual([]);
    expect(remoteRefs(s.origin)).toEqual(["refs/heads/master"]);
  });

  const TOKEN = `ghp_${"Zx9Qw8Er7Ty6".repeat(3)}`;

  /** No file the shift keeps holds the token. */
  function keptNowhere(s: Scratch): void {
    if (!existsSync(s.bodies)) return;
    for (const entry of readdirSync(s.bodies, { recursive: true })) {
      const path = join(s.bodies, String(entry));
      if (statSync(path).isFile())
        expect(readFileSync(path, "utf8")).not.toContain(TOKEN);
    }
  }

  test("a run body that holds what looks like a secret is refused as a body failure: nothing is checked, copied, pushed or opened, and the refusal names the kind, never the text", async () => {
    const s = scratch();
    const request = beadWorktree(s, "t-k1", 1);
    leaveBody(request.worktree, FILLED.replace("1 pass", `token ${TOKEN}`));
    const git = recordedGit();
    const gh = fakeGh();
    const check = recordedCheck();
    const refused = await openDraftPr(request, {
      git: git.run,
      gh: gh.run,
      checkPrBody: check.run,
    });
    expect(refused).toMatchObject({ ok: false, kind: "body", body: "run" });
    if (!refused.ok) {
      expect(refused.error).toContain("github-token");
      expect(refused.error).not.toContain(TOKEN);
    }
    expect(check.paths).toEqual([]);
    expect(git.calls.some((call) => call.args[0] === "push")).toBe(false);
    expect(gh.calls).toEqual([]);
    expect(remoteRefs(s.origin)).toEqual(["refs/heads/master"]);
    keptNowhere(s);
  });

  test("a secret in a commit subject the shift's own body would list, or in the title, is refused the same way", async () => {
    const s = scratch();
    const subject = beadWorktree(s, "t-k2", 0);
    commit(subject.worktree, "key.txt", `add the key ${TOKEN}`);
    const title = { ...beadWorktree(s, "t-k3", 1), title: `rotate ${TOKEN}` };
    leaveBody(title.worktree);
    for (const request of [subject, title]) {
      const gh = fakeGh();
      const refused = await openDraftPr(request, {
        git: toolRunner("git"),
        gh: gh.run,
        checkPrBody: prCheckRunner(REPO),
      });
      expect({ bead: request.beadId, refused }).toMatchObject({
        bead: request.beadId,
        refused: { ok: false, kind: "body" },
      });
      if (!refused.ok) expect(refused.error).not.toContain(TOKEN);
      expect(gh.calls).toEqual([]);
    }
    expect(remoteRefs(s.origin)).toEqual(["refs/heads/master"]);
    keptNowhere(s);
  });
});

describe("PR_FAILURES", () => {
  test("every failure has a fixed sentence for the bead's comment", () => {
    expect(Object.keys(PR_FAILURES).sort()).toEqual(
      ["body", "branch", "gh", "no-commits", "push", "url", "worktree"].sort(),
    );
    for (const sentence of Object.values(PR_FAILURES))
      expect(sentence).toMatch(/^[a-z][^\n]*[a-z]$/);
  });
});
