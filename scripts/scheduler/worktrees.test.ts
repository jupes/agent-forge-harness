import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import type { WorktreeEntry } from "../../types/beads";
import { bunFfi } from "../hearth/acl-windows";
import {
  comparablePath,
  createWorktree,
  type GitRun,
  gitRun,
  listWorktrees,
  mainCheckoutOf,
  parsePorcelainZ,
  type RegistryDeps,
  removeWorktree,
  STASH_WARNING,
} from "./worktrees";

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

/**
 * The limit for every test in this file (agent-forge-harness-7v3u). Most of
 * them make real worktrees, and a git call is a process start: about 40 ms on
 * Windows 11 with bun 1.3.10, 125 ms for a `worktree add`, 460 ms for the six
 * calls that make a repository. Measured there: alone the slowest test takes
 * 1.6 to 2.7 s. With 16 copies of this file running at once, every copy
 * failed one or two tests at bun's default 5 s; with this limit no copy
 * failed, the slowest test taking 7.1 s. `repo()` copies one prepared
 * repository, so the git calls that make it run once per file, not per test.
 * 60 s is the limit the other tests that spawn processes use, and
 * `setDefaultTimeout` holds for this file only.
 */
setDefaultTimeout(60_000);

/** The prepared repository `repo()` copies, one per `ignoreTrees` value. */
const prepared = new Map<boolean, string>();

/**
 * A scratch repository whose path has spaces, its own `git init` (the OS home
 * may itself be a repository), one commit, and `trees/` ignored as the
 * harness ignores it. The root stays short: git fails on very long paths.
 *
 * Each call is a copy of one repository made the first time it is asked for,
 * so a test starts no git process to get it. No test is given the original.
 *
 * That repository has `maintenance.auto` off (agent-forge-harness-vhiz). A
 * commit otherwise starts `git maintenance run --auto --detach`, which goes on
 * after the commit returns and creates and removes `objects/maintenance.lock`.
 * The copy made straight after can list that file and then fail to open it
 * (ENOENT). On ubuntu-latest with four copies of this file running at once,
 * as the isolation re-run in `scripts/ledger/test-isolation.test.ts` runs
 * them, 31 of 240 runs failed that way; none of 160 with the setting.
 */
function repo(ignoreTrees = true, tempParent = tmpdir()): string {
  let source = prepared.get(ignoreTrees);
  if (source === undefined) {
    source = makeRepo(ignoreTrees);
    prepared.set(ignoreTrees, source);
  }
  const root = mkdtempSync(join(tempParent, "wt "));
  roots.push(root);
  const dir = join(root, "repo x");
  cpSync(source, dir, { recursive: true });
  return dir;
}

function makeRepo(ignoreTrees: boolean): string {
  const root = mkdtempSync(join(tmpdir(), "wt "));
  roots.push(root);
  const dir = join(root, "repo x");
  mkdirSync(dir);
  git(dir, "init", "-q", "-b", "master");
  git(dir, "config", "user.email", "test@example.invalid");
  git(dir, "config", "user.name", "worktree test");
  git(dir, "config", "commit.gpgsign", "false");
  git(dir, "config", "maintenance.auto", "false");
  writeFileSync(
    join(dir, ".gitignore"),
    `${ignoreTrees ? "trees/\n" : ""}.agent-forge-session\n.tmp/\n`,
  );
  writeFileSync(join(dir, "readme.txt"), "scratch\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "first");
  return dir;
}

function shortWindowsPath(path: string): string {
  const { dlopen, FFIType } = bunFfi(),
    { GetShortPathNameW } = dlopen("kernel32.dll", {
      GetShortPathNameW: {
        args: [FFIType.ptr, FFIType.ptr, FFIType.u32],
        returns: FFIType.u32,
      },
    }).symbols,
    output = Buffer.alloc(32_768 * 2),
    length = GetShortPathNameW(
      Buffer.from(`${path}\0`, "utf16le"),
      output,
      32_768,
    );
  if (length === 0 || length >= 32_768)
    throw new Error("Windows did not provide a bounded short path.");
  return output.toString("utf16le", 0, length * 2);
}

/**
 * The path as Windows tools write it, with backslashes. Elsewhere a backslash
 * is an ordinary character in a file name, so the path is left as it is.
 */
const windowsSpelling = (path: string): string =>
  process.platform === "win32" ? path.replaceAll("/", "\\") : path;

/** The repository's own path as git prints it: the key the registry uses. */
const top = (dir: string): string => git(dir, "rev-parse", "--show-toplevel");

function assertPrivateScratchPath(scratch: string, candidate: string): void {
  const root = resolve(scratch);
  const rootRelative = relative(resolve(tmpdir()), root);
  const candidateRelative = relative(root, resolve(candidate));
  if (
    !roots.includes(root) ||
    !basename(root).startsWith("wt ") ||
    rootRelative === ".." ||
    rootRelative.startsWith(`..${sep}`) ||
    isAbsolute(rootRelative) ||
    candidateRelative === ".." ||
    candidateRelative.startsWith(`..${sep}`) ||
    isAbsolute(candidateRelative)
  ) {
    throw new Error("test path is outside its private scratch boundary");
  }
}

function cleanupFixtureJunction(scratch: string, link: string): Error | null {
  try {
    assertPrivateScratchPath(scratch, link);
    const linkInfo = lstatSync(link);
    if (!linkInfo.isSymbolicLink())
      throw new Error("fixture link path no longer names a link");
    unlinkSync(link);
    return null;
  } catch (error) {
    const missing =
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT";
    if (missing) return null;

    // This exact root came from repo(); never let an uncertain link reach the
    // shared recursive afterAll cleanup, even when boundary validation failed.
    const rootIndex = roots.indexOf(resolve(scratch));
    if (rootIndex >= 0) roots.splice(rootIndex, 1);
    return new Error(
      "fixture junction cleanup failed; private scratch root retained for inspection",
    );
  }
}

let ids = 0;
function deps(more: Partial<RegistryDeps> = {}): Partial<RegistryDeps> {
  return {
    newId: () => `t${(++ids).toString(16).padStart(5, "0")}`,
    now: () => new Date("2026-10-12T10:00:00.000Z"),
    home: () => "C:/no/such/home",
    ...more,
  };
}

function listed(main: string, more: Partial<RegistryDeps> = {}) {
  const answer = listWorktrees(main, deps(more));
  if (!answer.ok) throw new Error(answer.error);
  return answer.entries;
}

const byPath = (entries: WorktreeEntry[], path: string) =>
  entries.find((entry) => comparablePath(entry.path) === comparablePath(path));

function runState(
  holder: string,
  slug: string,
  fields: Record<string, unknown>,
): void {
  const dir = join(holder, ".tmp", "work", "forge-runs");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${slug}.json`),
    JSON.stringify({
      schemaVersion: 2,
      slug,
      phase: "research",
      completed: ["research"],
      artifacts: {},
      ...fields,
    }),
  );
}

describe("parsePorcelainZ", () => {
  test("reads main, a branch, detached, bare, locked and prunable records, reasons with spaces included", () => {
    const out = [
      "worktree C:/r/main\0HEAD aaaa\0branch refs/heads/master\0",
      "worktree C:/r/trees/a b\0HEAD bbbb\0branch refs/heads/feat/x\0locked busy right now\0",
      "worktree C:/r/other\0HEAD cccc\0detached\0prunable gitdir file points to non-existent location\0",
      "worktree C:/r/bare\0bare\0",
      "",
    ].join("\0");
    expect(parsePorcelainZ(out)).toEqual([
      {
        path: "C:/r/main",
        head: "aaaa",
        branch: "master",
        detached: false,
        bare: false,
        locked: false,
        prunable: false,
      },
      {
        path: "C:/r/trees/a b",
        head: "bbbb",
        branch: "feat/x",
        detached: false,
        bare: false,
        locked: true,
        prunable: false,
      },
      {
        path: "C:/r/other",
        head: "cccc",
        branch: null,
        detached: true,
        bare: false,
        locked: false,
        prunable: true,
      },
      {
        path: "C:/r/bare",
        head: null,
        branch: null,
        detached: false,
        bare: true,
        locked: false,
        prunable: false,
      },
    ]);
  });

  test("a bare `locked` with no reason is still locked; nothing is nothing", () => {
    expect(
      parsePorcelainZ("worktree /x\0HEAD a\0branch refs/heads/m\0locked\0\0")[0]
        ?.locked,
    ).toBe(true);
    expect(parsePorcelainZ("")).toEqual([]);
  });
});

test("a commit in the repository repo() copies starts no background maintenance, which would write into it while the next copy is made", () => {
  const dir = repo();
  writeFileSync(join(dir, "more.txt"), "more\n");
  git(dir, "add", ".");
  const traced = spawnSync("git", ["commit", "-q", "-m", "more"], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, GIT_TRACE: "1" },
  });
  expect(traced.status).toBe(0);
  expect(traced.stderr).toContain("built-in: git commit");
  expect(traced.stderr).not.toContain("maintenance");
});

describe("comparablePath", () => {
  test("an 8.3 short path, backslashes and drive case all meet git's spelling; a gone path still compares", () => {
    const dir = repo();
    // tmpdir() is the short form on this machine; git prints the long one.
    expect(comparablePath(dir)).toBe(comparablePath(top(dir)));
    expect(comparablePath(windowsSpelling(dir))).toBe(comparablePath(top(dir)));
    const gone = join(dir, "not", "there");
    expect(comparablePath(gone)).toBe(comparablePath(`${gone}/`));
  });
});

test.skipIf(process.platform !== "win32")(
  "a gone path whose only existing parent is a drive root is spelled with single slashes",
  () => {
    expect(comparablePath("Z:\\No\\Such\\Dir")).toMatch(/^z:\/no\/such\/dir$/);
    expect(comparablePath("C:\\AF-no-such-dir\\x")).toBe("c:/af-no-such-dir/x");
  },
);

/**
 * Under Bun 1.3.10 a timed synchronous spawn was given its limit less the time
 * since the previous one ended. Bun >=1.4.2 fixes it upstream; older local
 * runtimes use `spawn-clock.ts`. These remain runtime regressions on CI,
 * rather than mutation tests of that compatibility guard. Each first runs git
 * once, so the run under test follows a timed spawn whatever ran before it,
 * also when the test runs alone, then waits out a gap.
 */
describe("gitRun", () => {
  /** A git alias that runs `script` in the shell git uses for `!` aliases. */
  const alias = (script: string): string[] => [
    "-c",
    `alias.under-test=!${script}`,
    "under-test",
  ];

  /**
   * A gap just past the limit: without the clock reset git is killed at
   * once, and with it `git --version` has the whole 2 s, room for the
   * hundreds of ms one git call took in the isolation re-run on the
   * windows-latest runner (a 500 ms limit left too little; vhiz).
   */
  test("answers when more than its time limit has passed since the last run, rather than timing out before git could run", async () => {
    const limitMs = 2_000;
    expect(gitRun(["--version"], tmpdir(), limitMs).status).toBe(0);
    await Bun.sleep(limitMs * 1.1);
    const result = gitRun(["--version"], tmpdir(), limitMs);
    expect({ status: result.status, stdout: result.stdout }).toEqual({
      status: 0,
      stdout: expect.stringMatching(/^git version /),
    });
  });

  test("still runs git when the clock reset cannot start its child (no executable at process.execPath)", () => {
    const real = process.execPath;
    process.execPath = join(tmpdir(), "no such bun.exe");
    try {
      const result = gitRun(["--version"], tmpdir(), 5_000);
      expect({ status: result.status, stdout: result.stdout }).toEqual({
        status: 0,
        stdout: expect.stringMatching(/^git version /),
      });
    } finally {
      process.execPath = real;
    }
  });

  /**
   * The command sleeps 4.5 s, more than the 4.1 s the gap leaves without the
   * clock reset, and 3 s inside the limit for git, its shell and `sleep` to
   * start. With a 3 s limit and a 2 s sleep that margin was 1 s, and in the
   * isolation re-run on the 4-thread windows-latest runner, where one git
   * call took hundreds of ms, the command was stopped at the limit
   * (agent-forge-harness-vhiz, CI run 38993942691 attempt 2).
   */
  test("gives a command its whole time limit after a gap shorter than half the limit: one that needs more than the gap left finishes", async () => {
    const dir = repo();
    const limitMs = 7_500;
    expect(gitRun(["--version"], dir, limitMs).status).toBe(0);
    // Without the clock reset this run was killed about 4.1 s in.
    await Bun.sleep(limitMs * 0.45);
    const result = gitRun(alias("sleep 4.5 && echo done"), dir, limitMs);
    expect({ status: result.status, stdout: result.stdout.trim() }).toEqual({
      status: 0,
      stdout: "done",
    });
  });

  /**
   * The command needs more than 1 s, more than the 0.8 s the gap leaves
   * without the clock reset, and leaves 3 s of its 4 s limit for git, its
   * shell, `echo` and `sleep` to start (with a 3 s limit that was 2 s; vhiz).
   */
  test("runs a command that changes something exactly once, after a gap that left too little of the limit", async () => {
    const dir = repo();
    const limitMs = 4_000;
    expect(gitRun(["--version"], dir, limitMs).status).toBe(0);
    // Without the clock reset this run was killed about 0.8 s in, after its
    // write: a run that was then repeated wrote twice.
    await Bun.sleep(limitMs * 0.8);
    const result = gitRun(
      alias("echo ran >> marker.txt && sleep 1"),
      dir,
      limitMs,
    );
    expect({
      status: result.status,
      marker: readFileSync(join(dir, "marker.txt"), "utf8"),
    }).toEqual({ status: 0, marker: "ran\n" });
  });
});

describe("mainCheckoutOf", () => {
  test("is the main checkout from the main checkout and from a linked worktree", () => {
    const dir = repo();
    const main = mainCheckoutOf(dir, gitRun);
    expect(main && comparablePath(main)).toBe(comparablePath(top(dir)));
    const created = createWorktree(dir, dir, { branch: "feat/a" }, deps());
    if (!created.ok) throw new Error(created.error);
    const fromLinked = mainCheckoutOf(created.value.path, gitRun);
    expect(fromLinked && comparablePath(fromLinked)).toBe(
      comparablePath(top(dir)),
    );
  });
});

describe("createWorktree", () => {
  test("makes trees/<id> on a new branch from a path with spaces, and records it", () => {
    const dir = repo();
    const created = createWorktree(
      dir,
      dir,
      {
        branch: "feat/spaced",
        beadId: "agent-forge-harness-x1gs.5.2",
        sessionId: "session-1",
      },
      deps({ newId: () => "abc123" }),
    );
    if (!created.ok) throw new Error(created.error);
    expect(created.value).toEqual({
      id: "abc123",
      path: `${top(dir)}/trees/abc123`,
      branch: "feat/spaced",
      createdAt: "2026-10-12T10:00:00.000Z",
      beadId: "agent-forge-harness-x1gs.5.2",
      ownerSessionId: "session-1",
    });
    expect(git(created.value.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe(
      "feat/spaced",
    );
    const cache = JSON.parse(
      readFileSync(join(dir, "trees", ".state.json"), "utf8"),
    ) as { worktrees: unknown[] };
    expect(cache.worktrees).toEqual([created.value]);
  });

  test("the branch starts at the HEAD of the checkout it is made from, not the main checkout's", () => {
    const dir = repo();
    const first = createWorktree(dir, dir, { branch: "feat/one" }, deps());
    if (!first.ok) throw new Error(first.error);
    writeFileSync(join(first.value.path, "more.txt"), "more\n");
    git(first.value.path, "add", ".");
    git(first.value.path, "commit", "-q", "-m", "second");
    const second = createWorktree(
      dir,
      first.value.path,
      { branch: "feat/two" },
      deps(),
    );
    if (!second.ok) throw new Error(second.error);
    expect(git(second.value.path, "rev-parse", "HEAD")).toBe(
      git(first.value.path, "rev-parse", "HEAD"),
    );
    expect(git(dir, "rev-parse", "HEAD")).not.toBe(
      git(second.value.path, "rev-parse", "HEAD"),
    );
  });

  test("a start point: the branch starts at the commit it names, not at the HEAD of the checkout it is made from", () => {
    const dir = repo();
    git(dir, "checkout", "-q", "-b", "elsewhere");
    writeFileSync(join(dir, "elsewhere.txt"), "elsewhere\n");
    git(dir, "add", ".");
    git(dir, "commit", "-q", "-m", "on elsewhere");
    git(dir, "checkout", "-q", "master");
    const created = createWorktree(
      dir,
      dir,
      { branch: "feat/started", startPoint: "elsewhere" },
      deps(),
    );
    if (!created.ok) throw new Error(created.error);
    expect(git(created.value.path, "rev-parse", "HEAD")).toBe(
      git(dir, "rev-parse", "elsewhere"),
    );
    expect(git(created.value.path, "rev-parse", "HEAD")).not.toBe(
      git(dir, "rev-parse", "HEAD"),
    );
  });

  test("a start point that names no commit is refused before anything is made", () => {
    const dir = repo();
    const tree = git(dir, "rev-parse", "HEAD^{tree}");
    for (const startPoint of ["no-such-ref", "HEAD~9", tree]) {
      const refused = createWorktree(
        dir,
        dir,
        { branch: "feat/sp", startPoint },
        deps(),
      );
      expect({ startPoint, ok: refused.ok }).toEqual({
        startPoint,
        ok: false,
      });
      if (!refused.ok) expect(refused.error).toContain("start point");
    }
    expect(git(dir, "branch", "--list", "feat/sp")).toBe("");
    expect(existsSync(join(dir, "trees"))).toBe(false);
  });

  test("a start point that is empty, reads as an option or holds whitespace is refused without asking git about it", () => {
    const dir = repo();
    for (const startPoint of ["", "-x", "--all", "a b", "two\nlines"]) {
      const asked: string[][] = [];
      const recording: GitRun = (args, cwd, timeoutMs) => {
        asked.push([...args]);
        return gitRun(args, cwd, timeoutMs);
      };
      const refused = createWorktree(
        dir,
        dir,
        { branch: "feat/sq", startPoint },
        deps({ git: recording }),
      );
      expect({ startPoint, ok: refused.ok }).toEqual({
        startPoint,
        ok: false,
      });
      if (!refused.ok) expect(refused.error).toContain("start point");
      // git was asked about the repository and the branch, never about this start point.
      expect(
        asked.filter((args) =>
          args.some((arg) => startPoint !== "" && arg.includes(startPoint)),
        ),
      ).toEqual([]);
      expect(
        asked.filter((args) => args.some((arg) => arg.endsWith("^{commit}"))),
      ).toEqual([]);
    }
    expect(git(dir, "branch", "--list", "feat/sq")).toBe("");
    expect(existsSync(join(dir, "trees"))).toBe(false);
  });

  test("the session defaults to the mirror of the checkout it is made from", () => {
    const dir = repo();
    writeFileSync(join(dir, ".agent-forge-session"), "session-from-mirror\n");
    const created = createWorktree(dir, dir, { branch: "feat/m" }, deps());
    expect(created.ok && created.value.ownerSessionId).toBe(
      "session-from-mirror",
    );
  });

  test("a create git refuses leaves no branch and no record", () => {
    const dir = repo();
    // The target is taken: git makes the branch, then fails on the directory.
    mkdirSync(join(dir, "trees", "taken"), { recursive: true });
    writeFileSync(join(dir, "trees", "taken", "file.txt"), "in the way\n");
    const failed = createWorktree(
      dir,
      dir,
      { branch: "feat/blocked" },
      deps({ newId: () => "taken" }),
    );
    expect(failed.ok).toBe(false);
    expect(git(dir, "branch", "--list", "feat/blocked")).toBe("");
    expect(existsSync(join(dir, "trees", ".state.json"))).toBe(false);
  });

  test("a durable create preserves a partially created branch and occupied directory for reconciliation", () => {
    const dir = repo();
    mkdirSync(join(dir, "trees", "taken"), { recursive: true });
    const file = join(dir, "trees", "taken", "file.txt");
    writeFileSync(file, "keep this work\n");
    const failed = createWorktree(
      dir,
      dir,
      { branch: "feat/blocked", preserveOnFailure: true },
      deps({ newId: () => "taken" }),
    );
    expect(failed.ok).toBe(false);
    expect(git(dir, "branch", "--list", "feat/blocked")).toContain(
      "feat/blocked",
    );
    expect(readFileSync(file, "utf8")).toBe("keep this work\n");
    expect(existsSync(join(dir, "trees", ".state.json"))).toBe(false);
  });

  test("a name that is not a new branch is refused before anything is made", () => {
    const dir = repo();
    git(dir, "branch", "already");
    // So that @{-1} resolves, to a branch since deleted: check-ref-format
    // --branch expands it, and git would make that branch again under its name.
    git(dir, "checkout", "-q", "-b", "gone-before");
    git(dir, "checkout", "-q", "master");
    git(dir, "branch", "-q", "-D", "gone-before");
    for (const branch of [
      "@",
      "@{-1}",
      "-x",
      "a b",
      "a..b",
      "two\nlines",
      "",
      "already",
      "HEAD",
    ]) {
      const refused = createWorktree(dir, dir, { branch }, deps());
      expect({ branch, ok: refused.ok }).toEqual({ branch, ok: false });
    }
    expect(git(dir, "branch", "--format=%(refname:short)").split("\n")).toEqual(
      ["already", "master"],
    );
    expect(existsSync(join(dir, "trees"))).toBe(false);
  });

  test("a bead or session id that is not one is refused, and nothing is made", () => {
    const dir = repo();
    const cases = [
      { branch: "feat/b1", beadId: "not a bead" },
      { branch: "feat/b2", sessionId: "has space" },
      {
        branch: "feat/b3",
        sessionId: `ghp_${"a1B2c3D4e5".repeat(4)}`,
      },
    ];
    for (const request of cases)
      expect(createWorktree(dir, dir, request, deps()).ok).toBe(false);
    expect(git(dir, "branch", "--list", "feat/b*")).toBe("");
  });

  test("refused in a repository that does not ignore trees/, or that is the home directory", () => {
    const loose = repo(false);
    const refused = createWorktree(loose, loose, { branch: "feat/l" }, deps());
    expect(refused.ok ? "" : refused.error).toContain("trees/");
    expect(git(loose, "branch", "--list", "feat/l")).toBe("");

    const dir = repo();
    const home = createWorktree(
      dir,
      dir,
      { branch: "feat/h" },
      deps({ home: () => dir }),
    );
    expect(home.ok ? "" : home.error).toContain("home");
    expect(git(dir, "branch", "--list", "feat/h")).toBe("");
  });

  test("a global excludes file that ignores trees/ does not count", () => {
    const loose = repo(false);
    const excludes = join(loose, "..", "global-excludes");
    writeFileSync(excludes, "trees/\n");
    const viaGlobal: GitRun = (args, cwd, timeoutMs) =>
      gitRun(["-c", `core.excludesFile=${excludes}`, ...args], cwd, timeoutMs);
    const refused = createWorktree(
      loose,
      loose,
      { branch: "feat/g" },
      deps({ git: viaGlobal }),
    );
    expect(refused.ok).toBe(false);
  });
});

describe("listWorktrees", () => {
  test("every worktree, main first: trees, the desktop app's, others, locked, and a cached one git lost", () => {
    const dir = repo();
    const main = top(dir);
    const made = createWorktree(
      dir,
      dir,
      { branch: "feat/t", beadId: "agent-forge-harness-abc" },
      deps({ newId: () => "tt0001" }),
    );
    if (!made.ok) throw new Error(made.error);
    git(
      dir,
      "worktree",
      "add",
      "-q",
      "-b",
      "claude/x",
      "--",
      ".claude/worktrees/x y",
    );
    const elsewhere = join(dir, "..", "elsewhere");
    git(dir, "worktree", "add", "-q", "--detach", "--", elsewhere);
    git(dir, "worktree", "lock", "--reason", "held by a test", "--", elsewhere);
    // A record for a worktree git does not know.
    const cache = JSON.parse(
      readFileSync(join(dir, "trees", ".state.json"), "utf8"),
    ) as { worktrees: unknown[] };
    cache.worktrees.push({
      id: "gone01",
      path: join(dir, "trees", "gone01"),
      branch: "feat/gone",
      createdAt: "2026-10-01T00:00:00.000Z",
    });
    writeFileSync(join(dir, "trees", ".state.json"), JSON.stringify(cache));

    const entries = listed(dir);
    expect(entries.map((entry) => [entry.kind, entry.missing])).toEqual([
      ["main", false],
      ["trees", false],
      ["trees", true],
      ["claude", false],
      ["other", false],
    ]);
    expect(entries[0]).toMatchObject({ path: main, branch: "master" });
    expect(entries[1]).toMatchObject({
      id: "tt0001",
      branch: "feat/t",
      beadId: "agent-forge-harness-abc",
      createdAt: "2026-10-12T10:00:00.000Z",
    });
    expect(entries[2]).toMatchObject({ id: "gone01", branch: "feat/gone" });
    expect(entries[3]).toMatchObject({ branch: "claude/x" });
    expect(entries[3]?.id).toBeUndefined();
    expect(entries[4]).toMatchObject({
      detached: true,
      branch: null,
      locked: true,
    });
  });

  test("a cached path in 8.3 short form with backslashes is the worktree git lists, not a missing one", () => {
    const dir = repo();
    // dir is under tmpdir(), which is the short form here.
    const path = join(dir, "trees", "short1");
    git(dir, "worktree", "add", "-q", "-b", "feat/short", "--", path);
    writeFileSync(
      join(dir, "trees", ".state.json"),
      JSON.stringify({
        worktrees: [
          {
            id: "short1",
            path: windowsSpelling(path),
            branch: "feat/short",
            createdAt: "2026-10-02T00:00:00.000Z",
          },
        ],
      }),
    );
    const entries = listed(dir);
    expect(entries.length).toBe(2);
    expect(entries[1]).toMatchObject({ id: "short1", missing: false });
  });

  test("the bead comes from the cache, else from the newest run built there that names one", () => {
    const dir = repo();
    const main = top(dir);
    const a = createWorktree(dir, dir, { branch: "feat/a" }, deps());
    const b = createWorktree(
      dir,
      dir,
      { branch: "feat/b", beadId: "agent-forge-harness-cached" },
      deps(),
    );
    if (!a.ok || !b.ok) throw new Error("create failed");
    // The documented flow: the run's state stays in main, its checkout names the worktree.
    runState(dir, "older", {
      beadId: "agent-forge-harness-old",
      checkout: windowsSpelling(a.value.path),
      updatedAt: "2026-10-01T00:00:00.000Z",
    });
    runState(dir, "newer", {
      beadId: "agent-forge-harness-new",
      checkout: a.value.path,
      updatedAt: "2026-10-03T00:00:00.000Z",
    });
    // Newer still, but names no bead; and one with no time of its own.
    runState(dir, "nobead", {
      checkout: a.value.path,
      updatedAt: "2026-10-05T00:00:00.000Z",
    });
    // Named to be read first: a run with no time must not win by being first.
    runState(dir, "a-notime", {
      beadId: "agent-forge-harness-notime",
      checkout: a.value.path,
    });
    // A run kept in the worktree itself, with no checkout: it is that worktree's.
    runState(b.value.path, "inside", {
      beadId: "agent-forge-harness-inside",
      updatedAt: "2026-10-09T00:00:00.000Z",
    });
    // A run built in main.
    runState(dir, "mainrun", {
      beadId: "agent-forge-harness-main",
      checkout: main,
      updatedAt: "2026-10-04T00:00:00.000Z",
    });
    const entries = listed(dir);
    expect(byPath(entries, main)?.beadId).toBe("agent-forge-harness-main");
    expect(byPath(entries, a.value.path)?.beadId).toBe(
      "agent-forge-harness-new",
    );
    expect(byPath(entries, b.value.path)?.beadId).toBe(
      "agent-forge-harness-cached",
    );
  });

  test("a relative checkout is read against the checkout that holds the run", () => {
    const dir = repo();
    const a = createWorktree(
      dir,
      dir,
      { branch: "feat/rel" },
      deps({ newId: () => "rel001" }),
    );
    if (!a.ok) throw new Error(a.error);
    runState(dir, "relative", {
      beadId: "agent-forge-harness-rel",
      checkout: "trees/rel001",
      updatedAt: "2026-10-03T00:00:00.000Z",
    });
    expect(byPath(listed(dir), a.value.path)?.beadId).toBe(
      "agent-forge-harness-rel",
    );
  });

  test("the session is the live mirror, else the one that made it; a mirror that is not an id is not shown", () => {
    const dir = repo();
    const a = createWorktree(
      dir,
      dir,
      { branch: "feat/s1", sessionId: "maker-1" },
      deps(),
    );
    const b = createWorktree(
      dir,
      dir,
      { branch: "feat/s2", sessionId: "maker-2" },
      deps(),
    );
    const c = createWorktree(dir, dir, { branch: "feat/s3" }, deps());
    if (!a.ok || !b.ok || !c.ok) throw new Error("create failed");
    writeFileSync(join(a.value.path, ".agent-forge-session"), "live-1\n");
    writeFileSync(
      join(c.value.path, ".agent-forge-session"),
      `ghp_${"a1B2c3D4e5".repeat(4)}\n`,
    );
    const entries = listed(dir);
    expect(byPath(entries, a.value.path)?.sessionId).toBe("live-1");
    expect(byPath(entries, b.value.path)?.sessionId).toBe("maker-2");
    expect(byPath(entries, c.value.path)?.sessionId).toBeUndefined();
  });

  test("a directory that is not the top of a repository lists nothing; git failing is an error, not an empty list", () => {
    const loose = mkdtempSync(join(tmpdir(), "wt "));
    roots.push(loose);
    // Under the OS home, git may find the home's own repository: still nothing.
    expect(listWorktrees(loose, deps())).toEqual({ ok: true, entries: [] });
    const dir = repo();
    expect(listWorktrees(join(dir, "trees-not"), deps())).toEqual({
      ok: true,
      entries: [],
    });
    const hung: GitRun = () => ({ status: null, stdout: "", stderr: "" });
    const failed = listWorktrees(dir, deps({ git: hung }));
    expect(failed.ok).toBe(false);
    const broken: GitRun = (args, cwd, timeoutMs) =>
      args[0] === "worktree"
        ? { status: 1, stdout: "", stderr: "fatal: something" }
        : gitRun(args, cwd, timeoutMs);
    expect(listWorktrees(dir, deps({ git: broken })).ok).toBe(false);
  });

  test("a read writes nothing: a legacy forge state is left where it is", () => {
    const dir = repo();
    const a = createWorktree(dir, dir, { branch: "feat/legacy" }, deps());
    if (!a.ok) throw new Error(a.error);
    mkdirSync(join(a.value.path, ".tmp", "work"), { recursive: true });
    const legacy = join(a.value.path, ".tmp", "work", "forge-state.json");
    const text = JSON.stringify({
      slug: "old",
      phase: "plan",
      completed: ["research"],
      beadId: "agent-forge-harness-legacy",
    });
    writeFileSync(legacy, text);
    const cacheBefore = readFileSync(join(dir, "trees", ".state.json"), "utf8");
    listed(dir);
    expect(readFileSync(legacy, "utf8")).toBe(text);
    expect(readdirSync(join(a.value.path, ".tmp", "work"))).toEqual([
      "forge-state.json",
    ]);
    expect(readFileSync(join(dir, "trees", ".state.json"), "utf8")).toBe(
      cacheBefore,
    );
  });
});

describe("removeWorktree", () => {
  test.skipIf(process.platform !== "win32")(
    "the private scratch guard recognizes an actual 8.3 temp-root alias",
    () => {
      const normalTemp = resolve(tmpdir());
      const shortTemp = shortWindowsPath(normalTemp);
      expect(shortTemp.toLowerCase()).not.toBe(normalTemp.toLowerCase());
      expect(realpathSync.native(shortTemp).toLowerCase()).toBe(
        realpathSync.native(normalTemp).toLowerCase(),
      );

      const dir = repo(true, shortTemp);
      const scratch = resolve(dirname(dir));
      const made = createWorktree(
        dir,
        dir,
        { branch: "feat/short-temp-alias" },
        deps(),
      );
      if (!made.ok) throw new Error(made.error);

      // Git's returned worktree path and the fixture's short temp spelling
      // must both be accepted as one private scratch tree.
      assertPrivateScratchPath(scratch, made.value.path);
    },
  );

  test("a clean worktree is removed and its record dropped, a mirror file notwithstanding", () => {
    const dir = repo();
    const a = createWorktree(dir, dir, { branch: "feat/r" }, deps());
    if (!a.ok) throw new Error(a.error);
    writeFileSync(join(a.value.path, ".agent-forge-session"), "s-1\n");
    const removed = removeWorktree(dir, a.value.id, { force: false }, deps());
    expect(removed).toEqual({ ok: true, value: a.value });
    expect(existsSync(a.value.path)).toBe(false);
    expect(listed(dir).map((entry) => entry.kind)).toEqual(["main"]);
  });

  test("a worktree with changes is refused and kept, record included, unless forced", () => {
    const dir = repo();
    const a = createWorktree(dir, dir, { branch: "feat/dirty" }, deps());
    if (!a.ok) throw new Error(a.error);
    writeFileSync(join(a.value.path, "work.txt"), "unsaved\n");
    const refused = removeWorktree(dir, a.value.id, { force: false }, deps());
    expect(refused.ok).toBe(false);
    expect(existsSync(join(a.value.path, "work.txt"))).toBe(true);
    expect(byPath(listed(dir), a.value.path)?.id).toBe(a.value.id);
    const forced = removeWorktree(dir, a.value.id, { force: true }, deps());
    expect(forced.ok).toBe(true);
    expect(existsSync(a.value.path)).toBe(false);
  });

  function expectJunctionTargetPreserved(force: boolean): void {
    const dir = repo();
    const scratch = resolve(dirname(dir));
    const assertPrivateScratch = (): void => {
      const rel = relative(resolve(tmpdir()), scratch);
      if (
        !roots.includes(scratch) ||
        !basename(scratch).startsWith("wt ") ||
        rel === ".." ||
        rel.startsWith(`..${sep}`) ||
        isAbsolute(rel)
      ) {
        throw new Error(
          "fixture scratch root is outside its private temp boundary",
        );
      }
    };
    assertPrivateScratch();
    const target = resolve(scratch, "external marker target");
    const marker = join(target, "marker.bin");
    const assertWithinScratch = (candidate: string): void => {
      const rel = relative(scratch, resolve(candidate));
      if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
        throw new Error(
          `fixture path escaped its private scratch root: ${candidate}`,
        );
    };
    assertWithinScratch(dir);
    assertWithinScratch(target);
    assertWithinScratch(marker);
    mkdirSync(target);
    writeFileSync(marker, "private fixture marker\n");

    // Make the linked directory ignored and committed before creating the
    // worktree, so Git cannot refuse removal merely because it is untracked.
    writeFileSync(
      join(dir, ".gitignore"),
      `${readFileSync(join(dir, ".gitignore"), "utf8")}node_modules/\n`,
    );
    git(dir, "add", ".gitignore");
    git(dir, "commit", "-q", "-m", "ignore linked dependency fixture");

    const made = createWorktree(dir, dir, { branch: "feat/junction" }, deps());
    if (!made.ok) throw new Error(made.error);
    const path = resolve(made.value.path);
    const link = join(path, "node_modules");
    const cache = join(dir, "trees", ".state.json");

    assertWithinScratch(dir);
    assertWithinScratch(path);
    assertWithinScratch(target);
    assertWithinScratch(link);
    assertWithinScratch(cache);
    assertWithinScratch(marker);

    let testFailure: unknown;
    let testFailed = false;
    try {
      symlinkSync(
        target,
        link,
        process.platform === "win32" ? "junction" : "dir",
      );
      const linkBefore = lstatSync(link);
      expect(linkBefore.isSymbolicLink()).toBe(true);

      const markerBefore = readFileSync(marker, "utf8");
      const cacheBefore = readFileSync(cache, "utf8");
      const linkTargetBefore = readlinkSync(link, "utf8");
      const worktreesBefore = git(dir, "worktree", "list", "--porcelain");
      let removeCalls = 0;
      const spyingGit: GitRun = (args, cwd, timeoutMs) => {
        if (args[0] === "worktree" && args[1] === "remove") removeCalls += 1;
        return gitRun(args, cwd, timeoutMs);
      };

      const removed = removeWorktree(
        dir,
        made.value.id,
        { force },
        deps({ git: spyingGit }),
      );

      // Snapshot everything before assertions, including the external marker.
      const markerExistsAfter = existsSync(marker);
      const markerAfter = markerExistsAfter
        ? readFileSync(marker, "utf8")
        : null;
      const cacheAfter = existsSync(cache) ? readFileSync(cache, "utf8") : null;
      const worktreeAfter = existsSync(path);
      const worktreesAfter = git(dir, "worktree", "list", "--porcelain");
      let linkAfter: { isSymbolicLink: boolean; target: string } | null = null;
      try {
        linkAfter = {
          isSymbolicLink: lstatSync(link).isSymbolicLink(),
          target: readlinkSync(link, "utf8"),
        };
      } catch {
        // A missing link is recorded as changed and asserted below.
      }

      expect({
        marker: { exists: markerExistsAfter, contents: markerAfter },
        worktreeExists: worktreeAfter,
        worktrees: worktreesAfter,
        cache: cacheAfter,
        link: linkAfter,
        removeCalls,
        removed: removed.ok,
      }).toEqual({
        marker: { exists: true, contents: markerBefore },
        worktreeExists: true,
        worktrees: worktreesBefore,
        cache: cacheBefore,
        link: { isSymbolicLink: true, target: linkTargetBefore },
        removeCalls: 0,
        removed: false,
      });
    } catch (error) {
      testFailure = error;
      testFailed = true;
    }

    // Run cleanup outside finally so cleanup errors cannot mask assertions.
    const cleanupFailure = cleanupFixtureJunction(scratch, link);
    if (testFailed && cleanupFailure !== null)
      throw new AggregateError(
        [testFailure, cleanupFailure],
        "fixture assertion and junction cleanup both failed",
      );
    if (testFailed) throw testFailure;
    if (cleanupFailure !== null) throw cleanupFailure;
  }

  test("a junction to an external target is preserved without force", () => {
    expectJunctionTargetPreserved(false);
  });

  test("force cannot remove a worktree with a junction to an external target", () => {
    expectJunctionTargetPreserved(true);
  });

  test("refuses before Git remove when the entry inspection limit is exceeded", () => {
    const dir = repo();
    const made = createWorktree(
      dir,
      dir,
      { branch: "feat/entry-limit" },
      deps(),
    );
    if (!made.ok) throw new Error(made.error);
    const path = made.value.path;
    const scratch = resolve(dirname(dir));
    assertPrivateScratchPath(scratch, path);
    for (let index = 0; index <= 4_096; index += 1)
      writeFileSync(join(path, `inspection-entry-${index}.txt`), "");

    const cache = join(dir, "trees", ".state.json");
    assertPrivateScratchPath(scratch, cache);
    const cacheBefore = readFileSync(cache, "utf8");
    const worktreesBefore = git(dir, "worktree", "list", "--porcelain");
    let removeCalls = 0;
    const spyingGit: GitRun = (args, cwd, timeoutMs) => {
      if (args[0] === "worktree" && args[1] === "remove") removeCalls += 1;
      return gitRun(args, cwd, timeoutMs);
    };

    const removed = removeWorktree(
      dir,
      made.value.id,
      { force: true },
      deps({ git: spyingGit }),
    );
    const cacheAfter = readFileSync(cache, "utf8");
    const worktreeAfter = existsSync(path);
    const worktreesAfter = git(dir, "worktree", "list", "--porcelain");

    expect({
      result: removed.ok,
      reason: removed.ok ? "" : removed.error,
      removeCalls,
      worktreeAfter,
      worktreesAfter,
      cacheAfter,
    }).toEqual({
      result: false,
      reason: expect.stringContaining("bounded filesystem inspection limit"),
      removeCalls: 0,
      worktreeAfter: true,
      worktreesAfter: worktreesBefore,
      cacheAfter: cacheBefore,
    });
  });

  test("allows exactly 4096 descendant entries before Git remove", () => {
    const dir = repo();
    const made = createWorktree(
      dir,
      dir,
      { branch: "feat/entry-limit-boundary" },
      deps(),
    );
    if (!made.ok) throw new Error(made.error);
    const path = made.value.path;
    const scratch = resolve(dirname(dir));
    assertPrivateScratchPath(scratch, path);
    const baselineEntries = readdirSync(path).length;
    const remainingEntries = 4_096 - baselineEntries;
    if (remainingEntries < 0)
      throw new Error("fixture already exceeds the entry boundary");
    for (let index = 0; index < remainingEntries; index += 1)
      writeFileSync(join(path, `boundary-entry-${index}.txt`), "");

    let removeCalls = 0;
    const spyingGit: GitRun = (args, cwd, timeoutMs) => {
      if (args[0] === "worktree" && args[1] === "remove") removeCalls += 1;
      return gitRun(args, cwd, timeoutMs);
    };
    const removed = removeWorktree(
      dir,
      made.value.id,
      { force: true },
      deps({ git: spyingGit }),
    );
    const worktreeAfter = existsSync(path);

    expect({ result: removed.ok, removeCalls, worktreeAfter }).toEqual({
      result: true,
      removeCalls: 1,
      worktreeAfter: false,
    });
  });

  test("refuses before Git remove when directory depth exceeds 32", () => {
    const dir = repo();
    const made = createWorktree(
      dir,
      dir,
      { branch: "feat/depth-limit" },
      deps(),
    );
    if (!made.ok) throw new Error(made.error);
    const path = made.value.path;
    const scratch = resolve(dirname(dir));
    assertPrivateScratchPath(scratch, path);
    let nested = path;
    for (let depth = 1; depth <= 33; depth += 1) {
      nested = join(nested, "d");
      mkdirSync(nested);
    }

    const cache = join(dir, "trees", ".state.json");
    assertPrivateScratchPath(scratch, cache);
    const cacheBefore = readFileSync(cache, "utf8");
    const worktreesBefore = git(dir, "worktree", "list", "--porcelain");
    let removeCalls = 0;
    const spyingGit: GitRun = (args, cwd, timeoutMs) => {
      if (args[0] === "worktree" && args[1] === "remove") removeCalls += 1;
      return gitRun(args, cwd, timeoutMs);
    };

    const removed = removeWorktree(
      dir,
      made.value.id,
      { force: true },
      deps({ git: spyingGit }),
    );
    const cacheAfter = readFileSync(cache, "utf8");
    const worktreeAfter = existsSync(path);
    const worktreesAfter = git(dir, "worktree", "list", "--porcelain");

    expect({
      result: removed.ok,
      reason: removed.ok ? "" : removed.error,
      removeCalls,
      worktreeAfter,
      worktreesAfter,
      cacheAfter,
    }).toEqual({
      result: false,
      reason: expect.stringContaining("bounded directory-depth limit"),
      removeCalls: 0,
      worktreeAfter: true,
      worktreesAfter: worktreesBefore,
      cacheAfter: cacheBefore,
    });
  });

  test("allows directory depth 32 before Git remove", () => {
    const dir = repo();
    const made = createWorktree(
      dir,
      dir,
      { branch: "feat/depth-limit-boundary" },
      deps(),
    );
    if (!made.ok) throw new Error(made.error);
    const path = made.value.path;
    const scratch = resolve(dirname(dir));
    assertPrivateScratchPath(scratch, path);
    let nested = path;
    for (let depth = 1; depth <= 32; depth += 1) {
      nested = join(nested, "d");
      mkdirSync(nested);
    }

    let removeCalls = 0;
    const spyingGit: GitRun = (args, cwd, timeoutMs) => {
      if (args[0] === "worktree" && args[1] === "remove") removeCalls += 1;
      return gitRun(args, cwd, timeoutMs);
    };
    const removed = removeWorktree(
      dir,
      made.value.id,
      { force: true },
      deps({ git: spyingGit }),
    );
    const worktreeAfter = existsSync(path);

    expect({ result: removed.ok, removeCalls, worktreeAfter }).toEqual({
      result: true,
      removeCalls: 1,
      worktreeAfter: false,
    });
  });

  test("refuses if a listed worktree disappears before filesystem inspection", () => {
    const dir = repo();
    const made = createWorktree(
      dir,
      dir,
      { branch: "feat/inspection-race" },
      deps(),
    );
    if (!made.ok) throw new Error(made.error);
    const path = made.value.path;
    const scratch = resolve(dirname(dir));
    assertPrivateScratchPath(scratch, path);
    const cache = join(dir, "trees", ".state.json");
    assertPrivateScratchPath(scratch, cache);
    const cacheBefore = readFileSync(cache, "utf8");
    const listedBefore = byPath(listed(dir), path);
    if (!listedBefore)
      throw new Error("fixture worktree is missing from Git's list");
    const identityBefore = {
      path: comparablePath(listedBefore.path),
      id: listedBefore.id,
      branch: listedBefore.branch,
      head: listedBefore.head,
      kind: listedBefore.kind,
      detached: listedBefore.detached,
      locked: listedBefore.locked,
    };
    let injected = false;
    let removeCalls = 0;
    const racingGit: GitRun = (args, cwd, timeoutMs) => {
      const result = gitRun(args, cwd, timeoutMs);
      if (args[0] === "worktree" && args[1] === "list" && !injected) {
        injected = true;
        assertPrivateScratchPath(scratch, path);
        rmSync(path, { recursive: true, force: true, maxRetries: 5 });
      }
      if (args[0] === "worktree" && args[1] === "remove") removeCalls += 1;
      return result;
    };

    const removed = removeWorktree(
      dir,
      made.value.id,
      { force: false },
      deps({ git: racingGit }),
    );
    const cacheAfter = readFileSync(cache, "utf8");
    const worktreePathExistsAfter = existsSync(path);
    const listedAfter = byPath(listed(dir), path);
    const identityAfter = listedAfter
      ? {
          path: comparablePath(listedAfter.path),
          id: listedAfter.id,
          branch: listedAfter.branch,
          head: listedAfter.head,
          kind: listedAfter.kind,
          detached: listedAfter.detached,
          locked: listedAfter.locked,
        }
      : null;

    expect({
      result: removed.ok,
      reason: removed.ok ? "" : removed.error,
      injected,
      removeCalls,
      worktreePathExistsAfter,
      identityAfter,
      prunable: listedAfter?.prunable,
      cacheAfter,
    }).toEqual({
      result: false,
      reason: expect.stringContaining(
        "changed or could not be safely inspected",
      ),
      injected: true,
      removeCalls: 0,
      worktreePathExistsAfter: false,
      identityAfter: identityBefore,
      prunable: expect.any(Boolean),
      cacheAfter: cacheBefore,
    });
  });

  test("only a worktree this tool made can be removed; a record git no longer lists is dropped", () => {
    const dir = repo();
    git(
      dir,
      "worktree",
      "add",
      "-q",
      "-b",
      "claude/app",
      "--",
      ".claude/worktrees/app",
    );
    const unknown = removeWorktree(dir, "app", { force: true }, deps());
    expect(unknown.ok).toBe(false);
    expect(existsSync(join(dir, ".claude", "worktrees", "app"))).toBe(true);

    mkdirSync(join(dir, "trees"), { recursive: true });
    writeFileSync(
      join(dir, "trees", ".state.json"),
      JSON.stringify({
        worktrees: [
          {
            id: "lost01",
            path: join(dir, "trees", "lost01"),
            branch: "feat/lost",
            createdAt: "2026-10-01T00:00:00.000Z",
          },
        ],
      }),
    );
    const dropped = removeWorktree(dir, "lost01", { force: false }, deps());
    expect(dropped.ok).toBe(true);
    expect(listed(dir).some((entry) => entry.id === "lost01")).toBe(false);
  });
});

test("the stash warning says the stack is shared and how to use it safely", () => {
  expect(STASH_WARNING).toContain("shared by every worktree");
  expect(STASH_WARNING).toContain("git stash apply <sha>");
});

describe("the cache, written by something else", () => {
  const writeRecords = (dir: string, records: unknown[], extra = {}) => {
    mkdirSync(join(dir, "trees"), { recursive: true });
    writeFileSync(
      join(dir, "trees", ".state.json"),
      JSON.stringify({ worktrees: records, ...extra }),
    );
  };

  test("a record that names a path other than trees/<id> is not one: cleanup never reaches that worktree", () => {
    const dir = repo();
    const elsewhere = join(dir, "..", "hand made");
    git(dir, "worktree", "add", "-q", "-b", "hand", "--", elsewhere);
    git(
      dir,
      "worktree",
      "add",
      "-q",
      "-b",
      "claude/app",
      "--",
      ".claude/worktrees/app",
    );
    writeRecords(dir, [
      { id: "evil", path: elsewhere, branch: "hand", createdAt: "2026-10-01" },
      {
        id: "app",
        path: join(dir, ".claude", "worktrees", "app"),
        branch: "claude/app",
        createdAt: "2026-10-01",
      },
      {
        id: "../x",
        path: join(dir, "trees", "..", "x"),
        branch: "x",
        createdAt: "2026-10-01",
      },
    ]);
    for (const id of ["evil", "app", "../x"]) {
      const refused = removeWorktree(dir, id, { force: true }, deps());
      expect({ id, ok: refused.ok }).toEqual({ id, ok: false });
    }
    expect(existsSync(elsewhere)).toBe(true);
    expect(existsSync(join(dir, ".claude", "worktrees", "app"))).toBe(true);
    expect(listed(dir).filter((entry) => entry.id !== undefined)).toEqual([]);
  });

  test("remove keeps a record another process wrote while git was removing", () => {
    const dir = repo();
    const a = createWorktree(dir, dir, { branch: "feat/r1" }, deps());
    if (!a.ok) throw new Error(a.error);
    const late = {
      id: "late01",
      path: `${top(dir)}/trees/late01`,
      branch: "feat/late",
      createdAt: "2026-10-12T11:00:00.000Z",
    };
    // A create in another process finishes during the git call.
    const racing: GitRun = (args, cwd, timeoutMs) => {
      if (args[0] === "worktree" && args[1] === "remove") {
        const file = join(dir, "trees", ".state.json");
        const cache = JSON.parse(readFileSync(file, "utf8")) as {
          worktrees: unknown[];
        };
        cache.worktrees.push(late);
        writeFileSync(file, JSON.stringify(cache));
      }
      return gitRun(args, cwd, timeoutMs);
    };
    expect(
      removeWorktree(dir, a.value.id, { force: false }, deps({ git: racing }))
        .ok,
    ).toBe(true);
    const cache = JSON.parse(
      readFileSync(join(dir, "trees", ".state.json"), "utf8"),
    ) as { worktrees: Array<{ id: string }> };
    expect(cache.worktrees.map((record) => record.id)).toEqual(["late01"]);
    // Written whole, through a temporary file: none is left behind.
    expect(
      readdirSync(join(dir, "trees")).filter((name) => name.endsWith(".tmp")),
    ).toEqual([]);
  });

  test("a cache that does not parse, or is too large, is not written over: create is refused before git makes anything", () => {
    const dir = repo();
    mkdirSync(join(dir, "trees"), { recursive: true });
    writeFileSync(join(dir, "trees", ".state.json"), "{ not json");
    const refused = createWorktree(dir, dir, { branch: "feat/c1" }, deps());
    expect(refused.ok ? "" : refused.error).toContain("not JSON");
    expect(readFileSync(join(dir, "trees", ".state.json"), "utf8")).toBe(
      "{ not json",
    );
    expect(git(dir, "branch", "--list", "feat/c1")).toBe("");

    writeRecords(dir, [], { pad: "x".repeat(1_100_000) });
    const big = createWorktree(dir, dir, { branch: "feat/c2" }, deps());
    expect(big.ok ? "" : big.error).toContain("larger than");
    expect(git(dir, "branch", "--list", "feat/c2")).toBe("");
    // The listing still answers, without what the cache would have added.
    expect(listed(dir).map((entry) => entry.kind)).toEqual(["main"]);
  });
});

test("a branch name given as a ref is refused", () => {
  const dir = repo();
  const refused = createWorktree(dir, dir, { branch: "refs/heads/x" }, deps());
  expect(refused.ok).toBe(false);
  expect(git(dir, "for-each-ref", "--format=%(refname)", "refs/heads")).toBe(
    "refs/heads/master",
  );
});

test("an entry the registry does not recognise is ignored, never removed, and written back as it was", () => {
  const dir = repo();
  const legacy = {
    id: "old001",
    path: "C:/somewhere/else/trees/old001",
    branch: "feat/old",
    createdAt: "2026-09-01T00:00:00.000Z",
  };
  mkdirSync(join(dir, "trees"), { recursive: true });
  writeFileSync(
    join(dir, "trees", ".state.json"),
    JSON.stringify({ worktrees: [legacy] }),
  );
  const made = createWorktree(dir, dir, { branch: "feat/new" }, deps());
  if (!made.ok) throw new Error(made.error);
  const cache = JSON.parse(
    readFileSync(join(dir, "trees", ".state.json"), "utf8"),
  ) as { worktrees: unknown[] };
  expect(cache.worktrees).toEqual([made.value, legacy]);
  expect(removeWorktree(dir, "old001", { force: true }, deps()).ok).toBe(false);
});

test("a desktop-app worktree, which the registry did not make, gets its bead from its run and its session from its mirror", () => {
  const dir = repo();
  const app = join(dir, ".claude", "worktrees", "app one");
  git(dir, "worktree", "add", "-q", "-b", "claude/app-one", "--", app);
  writeFileSync(join(app, ".agent-forge-session"), "app-session-7\n");
  // The run's state is kept in the app worktree itself, with its checkout.
  runState(app, "apprun", {
    beadId: "agent-forge-harness-app",
    checkout: app,
    updatedAt: "2026-10-12T09:00:00.000Z",
  });
  const entry = byPath(listed(dir), app);
  expect(entry).toMatchObject({
    kind: "claude",
    branch: "claude/app-one",
    beadId: "agent-forge-harness-app",
    sessionId: "app-session-7",
  });
  expect(entry?.id).toBeUndefined();
});
