/**
 * The worktree registry: every git worktree of the harness, with the bead it
 * serves and the session working in it.
 *
 * `git worktree list --porcelain -z` is the source of truth. The cache,
 * `<main>/trees/.state.json`, holds only what git does not know about a
 * worktree this module made: its id, when it was made, its bead and the
 * session that made it. The bead of any other worktree comes from the forge
 * runs built there, and its session from the mirror the SessionStart hook
 * leaves in it.
 *
 * git is run with argument arrays, never through a shell, so a path with
 * spaces is one argument. A read writes nothing. A failed Git creation attempts
 * branch cleanup unless a durable caller preserves partial state. A remove never
 * discards work unless asked to (`force`), and removes only worktrees this module made.
 */

import { spawnSync } from "node:child_process";
import type { Dir, Dirent, Stats } from "node:fs";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  opendirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type {
  WorktreeEntry,
  WorktreeKind,
  WorktreeRecord,
} from "../../types/beads";
import {
  comparableCheckout,
  FORGE_RUNS_DIR,
  parseState,
  runSlugFromFilename,
} from "../forge/runs";
import { readSessionMirror } from "../ledger/identity";
import { parseBeadsIssueId } from "../run-correlation";
import { redactSecrets } from "../secret-patterns";
import { resetSpawnClock } from "../spawn-clock";

// ── git ─────────────────────────────────────────────────────────────────────

export interface GitResult {
  /** Null when git could not be started or was killed at its time limit. */
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Runs git with an argument array in `cwd`. Never a shell. */
export type GitRun = (
  args: readonly string[],
  cwd: string,
  timeoutMs?: number,
) => GitResult;

/** A read must not hold up whoever is waiting on it: the hearth answers other routes on the same thread. */
const READ_MS = 5_000;
const WRITE_MS = 30_000;

// Permit at most 4096 discovered descendants (the root is not counted).
// The worktree root is directory depth 0; depth 32 is allowed, but 33 is not.
const MAX_WORKTREE_INSPECTION_ENTRIES = 4_096;
const MAX_WORKTREE_DIRECTORY_DEPTH = 32;

export const gitRun: GitRun = (args, cwd, timeoutMs = WRITE_MS) => {
  // Under Bun a timed synchronous spawn is otherwise given its limit less the
  // time since the last one ended (`spawn-clock.ts`): git, run once, gets all
  // of `timeoutMs`.
  resetSpawnClock();
  const result = spawnSync("git", [...args], {
    cwd,
    encoding: "utf8",
    timeout: timeoutMs,
    windowsHide: true,
  });
  return {
    status: result.error ? null : result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
};

export interface RegistryDeps {
  git: GitRun;
  /** The session id mirrored into a worktree, or null. */
  readMirror(path: string): string | null;
  now(): Date;
  /** A new worktree id: it names the directory under `trees/`. */
  newId(): string;
  /** The OS home: a repository there is never one to add worktrees to. */
  home(): string;
}

const DEFAULT_DEPS: RegistryDeps = {
  git: gitRun,
  readMirror: (path) => readSessionMirror(path),
  now: () => new Date(),
  newId: () => Math.random().toString(16).slice(2, 8).padEnd(6, "0"),
  home: () => homedir(),
};

const withDefaults = (deps: Partial<RegistryDeps>): RegistryDeps => ({
  ...DEFAULT_DEPS,
  ...deps,
});

export type Outcome<T> = { ok: true; value: T } | { ok: false; error: string };

const no = <T>(error: string): Outcome<T> => ({
  ok: false,
  error: redactSecrets(error).text.slice(0, 500),
});

/** What git said, for an answer: its last error lines, made safe. */
function said(result: GitResult): string {
  const text = (result.stderr || result.stdout).trim();
  if (text !== "") return text;
  return result.status === null
    ? "git could not be run, or did not finish in time"
    : `git exited ${result.status}`;
}

/**
 * Refuse cleanup if the worktree contains links or cannot be inspected
 * completely. This is a bounded path-based snapshot check, not an atomic
 * filesystem transaction: a concurrent path replacement after inspection
 * remains outside this guard.
 */
function worktreeInspectionRefusal(root: string): string | null {
  const pending: Array<{ path: string; depth: number }> = [
    { path: root, depth: 0 },
  ];
  let entriesSeen = 0;

  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) return "the filesystem could not be safely inspected";

    let rootInfo: Stats;
    try {
      rootInfo = lstatSync(current.path);
    } catch {
      return "the filesystem changed or could not be safely inspected";
    }
    if (rootInfo.isSymbolicLink())
      return "the worktree contains a filesystem link or junction";
    if (!rootInfo.isDirectory())
      return "the worktree root or a directory changed during inspection";

    let directory: Dir;
    try {
      directory = opendirSync(current.path);
    } catch {
      return "the filesystem changed or could not be safely inspected";
    }

    let refusal: string | null = null;
    try {
      while (true) {
        let entry: Dirent | null;
        try {
          entry = directory.readSync();
        } catch {
          refusal = "the filesystem could not be safely inspected";
          break;
        }
        if (entry === null) break;

        entriesSeen += 1;
        if (entriesSeen > MAX_WORKTREE_INSPECTION_ENTRIES) {
          refusal =
            "the worktree exceeds the bounded filesystem inspection limit";
          break;
        }

        const childPath = join(current.path, entry.name);
        let childInfo: Stats;
        try {
          childInfo = lstatSync(childPath);
        } catch {
          refusal = "the filesystem changed or could not be safely inspected";
          break;
        }
        if (childInfo.isSymbolicLink()) {
          refusal = "the worktree contains a filesystem link or junction";
          break;
        }
        if (childInfo.isDirectory()) {
          const depth = current.depth + 1;
          if (depth > MAX_WORKTREE_DIRECTORY_DEPTH) {
            refusal = "the worktree exceeds the bounded directory-depth limit";
            break;
          }
          pending.push({ path: childPath, depth });
        } else if (!childInfo.isFile()) {
          refusal = "the worktree contains an unsupported filesystem entry";
          break;
        }
      }
    } finally {
      try {
        directory.closeSync();
      } catch {
        refusal ??= "the filesystem could not be safely inspected";
      }
    }

    if (refusal !== null) return refusal;
  }

  return null;
}

// ── Paths ───────────────────────────────────────────────────────────────────

/**
 * One spelling for a path, whoever wrote it: git prints `C:/Users/...`, Node
 * `C:\Users\...` or the 8.3 short form, and drive paths compare without case.
 * A path that is gone is spelled through its nearest existing parent.
 */
export function comparablePath(path: string): string {
  let existing = resolve(path);
  const rest: string[] = [];
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) break;
    rest.unshift(basename(existing));
    existing = parent;
  }
  let real = existing;
  try {
    real = realpathSync.native(existing);
  } catch {
    // Keep the spelling given.
  }
  return comparableCheckout(join(real, ...rest));
}

const inside = (outer: string, path: string): boolean =>
  path.startsWith(`${outer}/`);

/** Where a worktree comes from, by its location. */
export function worktreeKind(main: string, path: string): WorktreeKind {
  const m = comparablePath(main);
  const p = comparablePath(path);
  if (p === m) return "main";
  if (inside(`${m}/trees`, p)) return "trees";
  if (inside(`${m}/.claude/worktrees`, p)) return "claude";
  return "other";
}

/** The main checkout of the repository `cwd` is in: the directory holding the common `.git`. */
export function mainCheckoutOf(cwd: string, git: GitRun): string | null {
  const result = git(
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    cwd,
    READ_MS,
  );
  if (result.status !== 0) return null;
  const common = result.stdout.trim();
  return basename(common) === ".git" ? dirname(common) : null;
}

/**
 * `main` as git spells it, when it is the top of a repository; null when it
 * is not one (git, asked from a directory with no repository of its own, may
 * answer for a repository further up, such as the OS home's).
 */
function topOf(
  main: string,
  git: GitRun,
): { ok: true; top: string | null } | { ok: false; error: string } {
  if (!existsSync(main)) return { ok: true, top: null };
  const result = git(["rev-parse", "--show-toplevel"], main, READ_MS);
  if (result.status === null)
    return { ok: false, error: `git rev-parse failed: ${said(result)}` };
  if (result.status !== 0) return { ok: true, top: null };
  const top = result.stdout.trim();
  return {
    ok: true,
    top: comparablePath(top) === comparablePath(main) ? top : null,
  };
}

// ── git worktree list ───────────────────────────────────────────────────────

export interface GitWorktree {
  path: string;
  head: string | null;
  /** Without `refs/heads/`; null when detached or bare. */
  branch: string | null;
  detached: boolean;
  bare: boolean;
  locked: boolean;
  prunable: boolean;
}

/**
 * `git worktree list --porcelain -z`: one field per NUL, a record ended by an
 * empty field. Lock and prune reasons are free text, which is why `-z`.
 */
export function parsePorcelainZ(out: string): GitWorktree[] {
  const records: GitWorktree[] = [];
  let current: GitWorktree | null = null;
  for (const field of out.split("\0")) {
    if (field === "") {
      if (current) records.push(current);
      current = null;
      continue;
    }
    const space = field.indexOf(" ");
    const key = space === -1 ? field : field.slice(0, space);
    const value = space === -1 ? "" : field.slice(space + 1);
    if (key === "worktree") {
      if (current) records.push(current);
      current = {
        path: value,
        head: null,
        branch: null,
        detached: false,
        bare: false,
        locked: false,
        prunable: false,
      };
      continue;
    }
    if (!current) continue;
    if (key === "HEAD") current.head = value;
    else if (key === "branch")
      current.branch = value.replace(/^refs\/heads\//, "");
    else if (key === "detached") current.detached = true;
    else if (key === "bare") current.bare = true;
    else if (key === "locked") current.locked = true;
    else if (key === "prunable") current.prunable = true;
  }
  if (current) records.push(current);
  return records;
}

function gitWorktrees(main: string, git: GitRun): Outcome<GitWorktree[]> {
  const result = git(["worktree", "list", "--porcelain", "-z"], main, READ_MS);
  if (result.status !== 0)
    return no(`git worktree list failed: ${said(result)}`);
  return { ok: true, value: parsePorcelainZ(result.stdout) };
}

// ── Ids ─────────────────────────────────────────────────────────────────────

const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/** A session id that can be stored and shown: a plain token the secret scanner leaves alone. */
export function isSessionId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    SESSION_ID.test(value) &&
    redactSecrets(value).redactions.length === 0
  );
}

function isBead(value: unknown): value is string {
  return (
    typeof value === "string" &&
    parseBeadsIssueId(value) === value &&
    redactSecrets(value).redactions.length === 0
  );
}

// ── The cache ───────────────────────────────────────────────────────────────

const cacheFile = (main: string): string => join(main, "trees", ".state.json");

/** What `create` names a worktree: its directory under `trees/`. */
const WORKTREE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;

/** A cache larger than this is not read: reading it would hold up the hearth. */
const MAX_CACHE_BYTES = 1_000_000;

type CacheRead =
  | {
      ok: true;
      records: WorktreeRecord[];
      /** Entries kept as they were written and otherwise ignored: never listed, never removed. */
      others: unknown[];
    }
  | { ok: false; error: string };

/**
 * The records this module wrote. A missing file is none; one too large or
 * that does not parse is an error, so that nothing writes over it. A record
 * is kept only when it is one `create` could have written: a plain id, and
 * the path `<main>/trees/<id>`. Any other entry (one an older version wrote
 * from a linked worktree, or one written by hand) is ignored, so that
 * `remove` never reaches a worktree this module did not make, and is written
 * back as it was.
 */
function loadCache(main: string): CacheRead {
  const file = cacheFile(main);
  let text: string;
  try {
    if (statSync(file).size > MAX_CACHE_BYTES)
      return {
        ok: false,
        error: `${file} is larger than ${MAX_CACHE_BYTES} bytes; it is not read or written`,
      };
    text = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code === "ENOENT")
      return { ok: true, records: [], others: [] };
    return { ok: false, error: `${file} cannot be read` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {
      ok: false,
      error: `${file} is not JSON; fix or remove it by hand, it is not written over`,
    };
  }
  const list = (parsed as { worktrees?: unknown } | null)?.worktrees;
  if (!Array.isArray(list)) return { ok: true, records: [], others: [] };
  const records: WorktreeRecord[] = [];
  const others: unknown[] = [];
  for (const item of list) {
    const r = item as Partial<WorktreeRecord> | null;
    if (
      typeof r?.id !== "string" ||
      !WORKTREE_ID.test(r.id) ||
      typeof r.path !== "string" ||
      typeof r.branch !== "string" ||
      typeof r.createdAt !== "string" ||
      comparablePath(r.path) !== comparablePath(join(main, "trees", r.id))
    ) {
      others.push(item);
      continue;
    }
    records.push({
      id: r.id,
      path: r.path,
      branch: r.branch,
      createdAt: r.createdAt,
      ...(isBead(r.beadId) ? { beadId: r.beadId } : {}),
      ...(isSessionId(r.ownerSessionId)
        ? { ownerSessionId: r.ownerSessionId }
        : {}),
    });
  }
  return { ok: true, records, others };
}

/** The records this module wrote; a cache that cannot be read is read as none. */
export function readCache(main: string): WorktreeRecord[] {
  const read = loadCache(main);
  return read.ok ? read.records : [];
}

/**
 * Change the cache: read it again right before the write, so a record
 * another process wrote meanwhile is kept, and replace the file whole
 * through a temporary one. Two writers in the same millisecond can still
 * lose one record; there is no lock.
 */
function updateCache(
  main: string,
  change: (records: WorktreeRecord[]) => WorktreeRecord[],
): Outcome<void> {
  const read = loadCache(main);
  if (!read.ok) return no(read.error);
  const file = cacheFile(main);
  const temporary = `${file}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  try {
    mkdirSync(join(main, "trees"), { recursive: true });
    writeFileSync(
      temporary,
      `${JSON.stringify({ worktrees: [...change(read.records), ...read.others] }, null, 2)}\n`,
    );
    renameSync(temporary, file);
  } catch (error) {
    try {
      rmSync(temporary, { force: true });
    } catch {
      // Nothing more to take back.
    }
    return no(
      `${file} could not be written: ${(error as { code?: unknown } | null)?.code ?? "unknown error"}`,
    );
  }
  return { ok: true, value: undefined };
}

// ── Beads from forge runs ───────────────────────────────────────────────────

/**
 * The bead of the newest forge run built in each checkout, by comparable
 * path. A run is built where its state's `checkout` says (read against the
 * checkout holding the state when relative), else where the state is held.
 * Only runs that name a bead and record when they last wrote compete. Reads
 * the state files and nothing else: no migration, no write.
 */
function beadsFromRuns(holders: readonly string[]): Map<string, string> {
  const best = new Map<string, { beadId: string; at: string }>();
  for (const holder of holders) {
    const dir = join(holder, FORGE_RUNS_DIR);
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (runSlugFromFilename(name) === null) continue;
      let text: string;
      try {
        text = readFileSync(join(dir, name), "utf8");
      } catch {
        continue;
      }
      const state = parseState(text);
      // parseState stands in the current time for a state with none: such a run has no time to compete with.
      let at: unknown;
      try {
        at = (JSON.parse(text) as { updatedAt?: unknown }).updatedAt;
      } catch {
        continue;
      }
      if (!state || !isBead(state.beadId) || typeof at !== "string") continue;
      const where = comparablePath(
        state.checkout !== undefined && state.checkout !== ""
          ? resolve(holder, state.checkout)
          : holder,
      );
      const known = best.get(where);
      if (!known || at > known.at)
        best.set(where, { beadId: state.beadId, at });
    }
  }
  return new Map([...best].map(([where, run]) => [where, run.beadId]));
}

// ── Listing ─────────────────────────────────────────────────────────────────

export type Listed =
  | { ok: true; entries: WorktreeEntry[] }
  | { ok: false; error: string };

const KIND_ORDER: readonly WorktreeKind[] = [
  "main",
  "trees",
  "claude",
  "other",
];

/**
 * Every worktree of the repository whose main checkout is `main`: the main
 * checkout first, then the ones this module made, newest first, then the
 * rest by kind and path. A cached worktree git does not list is reported as
 * `missing`. A directory that is not the top of a repository has none; git
 * failing is an error, not an empty list.
 */
export function listWorktrees(
  main: string,
  partial: Partial<RegistryDeps> = {},
): Listed {
  const deps = withDefaults(partial);
  const top = topOf(main, deps.git);
  if (!top.ok) return top;
  if (top.top === null) return { ok: true, entries: [] };
  const listed = gitWorktrees(top.top, deps.git);
  if (!listed.ok) return listed;

  const cache = readCache(top.top);
  const cached = new Map(cache.map((r) => [comparablePath(r.path), r]));
  const worktrees = listed.value.filter((w) => !w.bare);
  const beads = beadsFromRuns(
    worktrees.map((w) => w.path).filter((path) => existsSync(path)),
  );

  const session = (path: string, record?: WorktreeRecord) => {
    const mirror = deps.readMirror(path);
    const id = isSessionId(mirror) ? mirror : record?.ownerSessionId;
    return id !== undefined ? { sessionId: id } : {};
  };
  const bead = (key: string, record?: WorktreeRecord) => {
    const id = record?.beadId ?? beads.get(key);
    return id !== undefined ? { beadId: id } : {};
  };
  const known = (record?: WorktreeRecord) =>
    record ? { id: record.id, createdAt: record.createdAt } : {};

  const seen = new Set<string>();
  const entries: WorktreeEntry[] = worktrees.map((w) => {
    const key = comparablePath(w.path);
    seen.add(key);
    const record = cached.get(key);
    return {
      path: w.path,
      kind: worktreeKind(top.top as string, w.path),
      branch: w.branch,
      head: w.head,
      detached: w.detached,
      locked: w.locked,
      prunable: w.prunable,
      missing: false,
      ...known(record),
      ...bead(key, record),
      ...session(w.path, record),
    };
  });
  for (const record of cache) {
    const key = comparablePath(record.path);
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({
      path: record.path,
      kind: worktreeKind(top.top, record.path),
      branch: record.branch,
      head: null,
      detached: false,
      locked: false,
      prunable: false,
      missing: true,
      ...known(record),
      ...bead(key, record),
      ...(record.ownerSessionId !== undefined
        ? { sessionId: record.ownerSessionId }
        : {}),
    });
  }
  return { ok: true, entries: entries.sort(order) };
}

function order(a: WorktreeEntry, b: WorktreeEntry): number {
  const rank = (e: WorktreeEntry) =>
    e.kind === "main" ? 0 : e.createdAt !== undefined ? 1 : 2;
  if (rank(a) !== rank(b)) return rank(a) - rank(b);
  if (a.createdAt !== undefined && b.createdAt !== undefined)
    return b.createdAt.localeCompare(a.createdAt);
  const kind = KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind);
  if (kind !== 0) return kind;
  return comparablePath(a.path).localeCompare(comparablePath(b.path));
}

// ── Creating ────────────────────────────────────────────────────────────────

export interface CreateRequest {
  branch: string;
  /** Durable callers reconcile their saved intent; preserve partial creation instead of deleting its branch. */
  preserveOnFailure?: true | undefined;
  beadId?: string | undefined;
  /** Defaults to the session mirrored into the checkout the worktree is made from. */
  sessionId?: string | undefined;
  /**
   * The commit the branch starts at: a ref or a sha, verified as a commit in
   * the main checkout. Defaults to the HEAD of the checkout it is made from.
   */
  startPoint?: string | undefined;
}

/** The commit a start point names, or why it names none. */
function startCommit(
  startPoint: string,
  main: string,
  git: GitRun,
): Outcome<string> {
  if (startPoint === "" || startPoint.startsWith("-") || /\s/.test(startPoint))
    return no(`the start point "${startPoint}" is not a ref`);
  const resolved = git(
    ["rev-parse", "--verify", "--quiet", `${startPoint}^{commit}`],
    main,
    READ_MS,
  );
  const sha = resolved.stdout.trim();
  if (resolved.status !== 0 || !/^[0-9a-f]{40,64}$/.test(sha))
    return no(`the start point "${startPoint}" names no commit`);
  return { ok: true, value: sha };
}

/** Why a branch name is refused, or null when it names a branch that does not exist yet. */
function refuseBranch(
  branch: string,
  main: string,
  git: GitRun,
): string | null {
  if (branch === "" || /[\r\n\0]/.test(branch) || branch === "@")
    return `"${branch}" is not a branch name`;
  if (branch.startsWith("-")) return `a branch name cannot start with "-"`;
  // git takes refs/heads/x as the branch "refs/heads/x", under refs/heads/.
  if (branch.startsWith("refs/"))
    return `give the branch name without "refs/": "${branch}"`;
  const format = git(["check-ref-format", "--branch", branch], main, READ_MS);
  // `--branch` expands shorthands such as @{-1}: the name must come back as given.
  if (format.status !== 0 || format.stdout.trim() !== branch)
    return `"${branch}" is not a branch name`;
  const exists = git(
    ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`],
    main,
    READ_MS,
  );
  if (exists.status === 0) return `branch "${branch}" already exists`;
  return null;
}

/**
 * Whether git ignores `rel` in `main` by a rule of `main`'s own: its
 * `.gitignore` files or `.git/info/exclude`, not a global excludes file.
 */
function ignoredHere(main: string, rel: string, git: GitRun): boolean {
  const result = git(["check-ignore", "-v", "--", rel], main, READ_MS);
  if (result.status !== 0) return false;
  // `<source>:<line>:<pattern>\t<path>`; a Windows source has a colon of its own.
  const match = /^(.*):(\d+):(.*)\t/.exec(result.stdout);
  const pattern = match?.[3];
  let source = match?.[1];
  if (!source || pattern === undefined || pattern.startsWith("!")) return false;
  // git quotes a source with backslashes or unusual characters, C style.
  if (source.startsWith('"')) {
    try {
      source = JSON.parse(source) as string;
    } catch {
      return false;
    }
  }
  const where = isAbsolute(source) ? source : join(main, source);
  return inside(comparablePath(main), comparablePath(where));
}

/**
 * Make `<main>/trees/<id>` on a new branch, and record it. The branch starts
 * at the request's start point when it has one (a commit, verified in the
 * main checkout), else at the HEAD of `from`, the checkout the command runs
 * in. Refused before anything is made: a name that is not a new branch, a
 * bead or session id that is not one, a start point that names no commit, a
 * repository that does not ignore `trees/` itself, the OS home. Failed Git
 * creation attempts branch cleanup unless preserveOnFailure is set.
 */
export function createWorktree(
  main: string,
  from: string,
  request: CreateRequest,
  partial: Partial<RegistryDeps> = {},
): Outcome<WorktreeRecord> {
  const deps = withDefaults(partial);
  if (request.beadId !== undefined && !isBead(request.beadId))
    return no("--bead: expected a Beads issue id");
  if (request.sessionId !== undefined && !isSessionId(request.sessionId))
    return no("--session: expected a session id");

  const top = topOf(main, deps.git);
  if (!top.ok) return top;
  if (top.top === null) return no(`${main} is not the top of a git repository`);
  const root = top.top;
  if (comparablePath(root) === comparablePath(deps.home()))
    return no(
      "the repository is the home directory: worktrees are made only in a project checkout",
    );

  const branch = refuseBranch(request.branch, root, deps.git);
  if (branch !== null) return no(branch);

  // A cache that cannot be written is found before git makes anything.
  const cache = loadCache(root);
  if (!cache.ok) return no(cache.error);
  const id = deps.newId();
  if (!WORKTREE_ID.test(id)) return no("a worktree id must be a plain name");
  if (!ignoredHere(root, `trees/${id}`, deps.git))
    return no(
      "trees/ is not ignored by this repository's own .gitignore: add `trees/` there before making worktrees in it",
    );

  let sha: string;
  if (request.startPoint !== undefined) {
    const start = startCommit(request.startPoint, root, deps.git);
    if (!start.ok) return start;
    sha = start.value;
  } else {
    const start = deps.git(["rev-parse", "HEAD"], from, READ_MS);
    if (start.status !== 0)
      return no(
        `the checkout ${from} has no HEAD to start from: ${said(start)}`,
      );
    sha = start.stdout.trim();
  }

  const mirror = deps.readMirror(from);
  const sessionId =
    request.sessionId ?? (isSessionId(mirror) ? mirror : undefined);
  const path = `${root}/trees/${id}`;
  const added = deps.git(
    ["worktree", "add", "-b", request.branch, "--", path, sha],
    root,
    WRITE_MS,
  );
  if (added.status !== 0) {
    if (request.preserveOnFailure)
      return no(
        `git worktree add did not confirm creation: ${said(added)} (partial work was preserved for inspection)`,
      );
    // git can make the branch and then fail on the directory: take it back.
    const left = deps.git(
      ["rev-parse", "--verify", "--quiet", `refs/heads/${request.branch}`],
      root,
      READ_MS,
    );
    const rolledBack =
      left.status !== 0 ||
      deps.git(["branch", "-D", request.branch], root, WRITE_MS).status === 0;
    return no(
      `git worktree add failed: ${said(added)}${rolledBack ? "" : ` (the branch ${request.branch} it made could not be deleted)`}`,
    );
  }

  const record: WorktreeRecord = {
    id,
    path,
    branch: request.branch,
    createdAt: deps.now().toISOString(),
    ...(request.beadId !== undefined ? { beadId: request.beadId } : {}),
    ...(sessionId !== undefined ? { ownerSessionId: sessionId } : {}),
  };
  const recorded = updateCache(root, (records) => [...records, record]);
  if (!recorded.ok)
    return no(
      `the worktree ${path} was made, but not recorded: ${recorded.error}`,
    );
  return { ok: true, value: record };
}

// ── Removing ────────────────────────────────────────────────────────────────

/**
 * Remove a worktree this module made, by its id. Without `force` git refuses
 * a worktree with changes, and the refusal is the answer: nothing is lost
 * and the record stays. A record whose worktree git no longer lists is
 * dropped. A worktree this module did not make (the desktop app's, a hand
 * made one) is never removed.
 */
export function removeWorktree(
  main: string,
  id: string,
  options: { force: boolean },
  partial: Partial<RegistryDeps> = {},
): Outcome<WorktreeRecord> {
  const deps = withDefaults(partial);
  const top = topOf(main, deps.git);
  if (!top.ok) return top;
  if (top.top === null) return no(`${main} is not the top of a git repository`);
  const root = top.top;
  const record = readCache(root).find((r) => r.id === id);
  if (!record)
    return no(
      `no worktree with the id "${id}" was made by bun run worktree; only those are removed`,
    );
  const drop = (): Outcome<WorktreeRecord> => {
    const dropped = updateCache(root, (records) =>
      records.filter((r) => r.id !== id),
    );
    return dropped.ok ? { ok: true, value: record } : dropped;
  };
  const listedNow = (): Outcome<boolean> => {
    const listed = gitWorktrees(root, deps.git);
    if (!listed.ok) return listed;
    const key = comparablePath(record.path);
    return {
      ok: true,
      value: listed.value.some((w) => comparablePath(w.path) === key),
    };
  };

  const before = listedNow();
  if (!before.ok) return before;
  if (!before.value) return drop();
  const inspectionRefusal = worktreeInspectionRefusal(record.path);
  if (inspectionRefusal !== null)
    return no(`git worktree remove refused: ${inspectionRefusal}`);
  const removed = deps.git(
    [
      "worktree",
      "remove",
      ...(options.force ? ["--force"] : []),
      "--",
      record.path,
    ],
    root,
    WRITE_MS,
  );
  if (removed.status === 0) return drop();
  const after = listedNow();
  if (after.ok && !after.value) return drop();
  return no(
    `git worktree remove refused ${record.path}: ${said(removed)}${options.force ? "" : " (it has changes or is locked; nothing was removed. --force discards them)"}`,
  );
}

/** Printed by `create` and `list`, and written into the agents' instructions (aenb). */
export const STASH_WARNING =
  "git stash is one stack shared by every worktree of this repository: another session can pop your entry, or you theirs. Prefer a WIP commit. If you must stash, use `git stash push -u -m <unique-tag>`, restore with `git stash apply <sha>`, and drop only your own entry, found by its tag. Never run a bare `git stash pop`, `git stash drop` or `git stash clear`.";
