import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { comparableCheckout } from "../forge/runs";
import { resolveCheckout } from "./workspace";

const temporary: string[] = [];

/** A scratch directory whose name contains a space. No git is involved. */
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "ledger test "));
  temporary.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of temporary.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

/** A main checkout: a directory holding a `.git` directory. */
function mainCheckout(root: string): string {
  const checkout = join(root, "main repo");
  mkdirSync(join(checkout, ".git", "worktrees"), { recursive: true });
  return checkout;
}

/** A linked worktree of `main`: a `.git` file pointing into the main `.git`. */
function linkedWorktree(root: string, main: string, relative = false): string {
  const worktree = join(root, "linked trees", "feature one");
  const gitDir = join(main, ".git", "worktrees", "feature one");
  mkdirSync(worktree, { recursive: true });
  mkdirSync(gitDir, { recursive: true });
  writeFileSync(join(gitDir, "commondir"), "../..\n");
  const pointer = relative
    ? "../../main repo/.git/worktrees/feature one"
    : gitDir.replaceAll("\\", "/");
  writeFileSync(join(worktree, ".git"), `gitdir: ${pointer}\n`);
  return worktree;
}

describe("resolveCheckout", () => {
  test("a checkout with a .git directory is its own workspace", () => {
    const main = mainCheckout(scratch());
    expect(resolveCheckout(main)).toEqual({
      workspace: comparableCheckout(main),
      worktree: comparableCheckout(main),
    });
  });

  test("a linked worktree resolves to the main checkout as workspace and itself as worktree", () => {
    const root = scratch();
    const main = mainCheckout(root);
    const worktree = linkedWorktree(root, main);
    expect(resolveCheckout(worktree)).toEqual({
      workspace: comparableCheckout(main),
      worktree: comparableCheckout(worktree),
    });
  });

  test("a linked worktree whose gitdir pointer is relative resolves the same way", () => {
    const root = scratch();
    const main = mainCheckout(root);
    const worktree = linkedWorktree(root, main, true);
    expect(resolveCheckout(worktree)).toEqual({
      workspace: comparableCheckout(main),
      worktree: comparableCheckout(worktree),
    });
  });

  test("a subdirectory resolves like its checkout", () => {
    const root = scratch();
    const main = mainCheckout(root);
    const worktree = linkedWorktree(root, main);
    const deepMain = join(main, "scripts", "ledger");
    const deepTree = join(worktree, "scripts", "some dir");
    mkdirSync(deepMain, { recursive: true });
    mkdirSync(deepTree, { recursive: true });
    expect(resolveCheckout(deepMain)).toEqual(resolveCheckout(main));
    expect(resolveCheckout(deepTree)).toEqual({
      workspace: comparableCheckout(main),
      worktree: comparableCheckout(worktree),
    });
  });

  test("a directory with no git falls back to itself", () => {
    const root = scratch();
    const plain = join(root, "no git here", "deeper");
    mkdirSync(plain, { recursive: true });
    // The walk is fenced at the scratch root so a repository above the temp
    // directory cannot change the answer.
    expect(resolveCheckout(plain, { stopAt: root })).toEqual({
      workspace: comparableCheckout(plain),
      worktree: comparableCheckout(plain),
    });
  });
});
