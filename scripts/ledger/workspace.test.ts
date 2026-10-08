import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { comparableCheckout } from "../forge/runs";
import { resolveCheckout } from "./workspace";

const temporary: string[] = [];

/**
 * A scratch directory whose name contains a space, spelled the way the file
 * system reports it (the temp directory may be an 8.3 short name or a link).
 * No git is involved.
 */
function scratch(): string {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "ledger test ")));
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

  // The same file-system call expands Windows 8.3 short names; that spelling
  // is only exercised on a machine whose temp directory has one.
  test("a checkout reached through a link resolves to the same workspace and worktree as its real path", () => {
    const root = scratch();
    const main = mainCheckout(root);
    const alias = join(root, "alias of main");
    symlinkSync(main, alias, "junction");
    const deep = join(main, "scripts");
    mkdirSync(deep, { recursive: true });
    expect(resolveCheckout(alias)).toEqual(resolveCheckout(main));
    expect(resolveCheckout(join(alias, "scripts"))).toEqual({
      workspace: comparableCheckout(main),
      worktree: comparableCheckout(main),
    });
  });

  test("the spelling the temp directory was given in resolves like the spelling the file system reports", () => {
    const given = mkdtempSync(join(tmpdir(), "ledger test "));
    temporary.push(given);
    mkdirSync(join(given, ".git"));
    expect(resolveCheckout(given).workspace).toBe(
      comparableCheckout(realpathSync.native(given)),
    );
  });

  test("a directory that does not exist falls back to the path as given", () => {
    const missing = join(scratch(), "never made");
    expect(resolveCheckout(missing, { stopAt: missing })).toEqual({
      workspace: comparableCheckout(missing),
      worktree: comparableCheckout(missing),
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
