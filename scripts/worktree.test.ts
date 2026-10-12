/**
 * `bun run worktree` as an agent runs it: the real script, spawned in a
 * scratch repository whose path has spaces (agent-forge-harness-5mge).
 */

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { WorktreeResult } from "../types/beads";

const SCRIPT = resolve(import.meta.dir, "worktree.ts");
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

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), "wt "));
  roots.push(root);
  const dir = join(root, "repo x");
  mkdirSync(dir);
  git(dir, "init", "-q", "-b", "master");
  git(dir, "config", "user.email", "test@example.invalid");
  git(dir, "config", "user.name", "worktree test");
  git(dir, "config", "commit.gpgsign", "false");
  writeFileSync(join(dir, ".gitignore"), "trees/\n.agent-forge-session\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "first");
  return dir;
}

function cli(
  cwd: string,
  ...args: string[]
): { exit: number | null; out: WorktreeResult } {
  const result = spawnSync("bun", [SCRIPT, ...args], {
    cwd,
    encoding: "utf8",
    timeout: 60_000,
  });
  let out: WorktreeResult;
  try {
    out = JSON.parse(result.stdout) as WorktreeResult;
  } catch {
    throw new Error(
      `not JSON (exit ${result.status}): ${result.stdout}${result.stderr}`,
    );
  }
  return { exit: result.status, out };
}

const branches = (dir: string): string[] =>
  git(dir, "branch", "--format=%(refname:short)").split("\n");

describe("bun run worktree, in a repository whose path has spaces", () => {
  test("create, list and cleanup: the worktree is made under trees/, listed with its bead, and removed", () => {
    const dir = repo();
    const top = git(dir, "rev-parse", "--show-toplevel");
    const created = cli(
      dir,
      "create",
      "feat/spaced",
      "--bead",
      "agent-forge-harness-x1gs.5.2",
    );
    expect(created.exit).toBe(0);
    expect(created.out.ok).toBe(true);
    const made = created.out.worktree;
    if (!made) throw new Error("no worktree in the answer");
    expect(made.path).toBe(`${top}/trees/${made.id}`);
    expect(made.branch).toBe("feat/spaced");
    expect(existsSync(made.path)).toBe(true);
    expect(git(made.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe(
      "feat/spaced",
    );
    expect(created.out.warnings?.[0]).toContain("shared by every worktree");

    const listed = cli(dir, "list");
    expect(listed.exit).toBe(0);
    expect(
      listed.out.worktrees?.map((entry) => [entry.kind, entry.id ?? null]),
    ).toEqual([
      ["main", null],
      ["trees", made.id],
    ]);
    expect(listed.out.worktrees?.[1]?.beadId).toBe(
      "agent-forge-harness-x1gs.5.2",
    );
    expect(listed.out.warnings?.[0]).toContain("shared by every worktree");

    const cleaned = cli(dir, "cleanup", made.id);
    expect(cleaned.exit).toBe(0);
    expect(existsSync(made.path)).toBe(false);
    expect(cli(dir, "list").out.worktrees?.length).toBe(1);
  });

  test("run from a linked worktree, it uses the main checkout's registry", () => {
    const dir = repo();
    const first = cli(dir, "create", "feat/first").out.worktree;
    if (!first) throw new Error("create failed");
    const second = cli(first.path, "create", "feat/second");
    expect(second.exit).toBe(0);
    expect(second.out.worktree?.path).toContain("/repo x/trees/");
    expect(
      cli(first.path, "list").out.worktrees?.filter((e) => e.kind === "trees")
        .length,
    ).toBe(2);
  });

  test("a create that is refused exits 1 and leaves no branch and no worktree", () => {
    const dir = repo();
    for (const branch of ["@{-1}", "-x", "a b"]) {
      const refused = cli(dir, "create", branch);
      expect({ branch, exit: refused.exit, ok: refused.out.ok }).toEqual({
        branch,
        exit: 1,
        ok: false,
      });
    }
    expect(branches(dir)).toEqual(["master"]);
    expect(existsSync(join(dir, "trees"))).toBe(false);
  });

  test("cleanup keeps a worktree with changes unless --force; cleanup-all removes the clean ones and reports the rest", () => {
    const dir = repo();
    const dirty = cli(dir, "create", "feat/dirty").out.worktree;
    const clean = cli(dir, "create", "feat/clean").out.worktree;
    if (!dirty || !clean) throw new Error("create failed");
    writeFileSync(join(dirty.path, "work.txt"), "unsaved\n");

    const refused = cli(dir, "cleanup", dirty.id);
    expect(refused.exit).toBe(1);
    expect(existsSync(join(dirty.path, "work.txt"))).toBe(true);

    const all = cli(dir, "cleanup-all");
    expect(all.exit).toBe(1);
    expect(existsSync(clean.path)).toBe(false);
    expect(existsSync(dirty.path)).toBe(true);
    expect(cli(dir, "list").out.worktrees?.map((e) => e.id ?? null)).toEqual([
      null,
      dirty.id,
    ]);

    expect(cli(dir, "cleanup", dirty.id, "--force").exit).toBe(0);
    expect(existsSync(dirty.path)).toBe(false);
  });

  test("an unknown command or a missing argument is a usage error", () => {
    const dir = repo();
    expect(cli(dir, "nothing").exit).toBe(1);
    expect(cli(dir, "create").exit).toBe(1);
    expect(cli(dir, "cleanup").exit).toBe(1);
    expect(cli(dir, "create", "feat/x", "--bead").exit).toBe(1);
  });
});
