/**
 * Which checkout a directory belongs to, read from the file system alone.
 *
 * `workspace` is the main checkout (what the ledger's `workspace` column
 * holds); `worktree` is the checkout the directory is actually in. They differ
 * only inside a linked git worktree. No `git` process is spawned: emitters run
 * inside hooks and must stay fast.
 *
 * Both are spelled the way the file system reports the directory, so one
 * directory is one workspace however it was reached: a Windows 8.3 short name
 * (`C:UsersLONGNA~1`) and a link or junction resolve to the real path.
 */

import { existsSync, readFileSync, realpathSync, statSync } from "fs";
import { dirname, isAbsolute, resolve } from "path";
import { comparableCheckout } from "../forge/runs";

export interface Checkout {
  workspace: string;
  worktree: string;
}

const resolved = new Map<string, Checkout>();

/** A directory in comparable form, by its real path; by the path as given when it cannot be read. */
function comparableOnDisk(path: string): string {
  try {
    return comparableCheckout(realpathSync.native(path));
  } catch {
    return comparableCheckout(path);
  }
}

function readLine(path: string): string | null {
  try {
    const line = readFileSync(path, "utf8").split(/\r?\n/)[0]?.trim();
    return line && line.length > 0 ? line : null;
  } catch {
    return null;
  }
}

/** The main checkout a linked worktree's `.git` file leads to, or null when it cannot be followed. */
function mainCheckoutOf(worktree: string, gitFile: string): string | null {
  const pointer = readLine(gitFile);
  if (!pointer?.startsWith("gitdir:")) return null;
  const target = pointer.slice("gitdir:".length).trim();
  const gitDir = isAbsolute(target) ? target : resolve(worktree, target);
  const common = readLine(resolve(gitDir, "commondir"));
  if (common === null) return null;
  const commonGitDir = isAbsolute(common) ? common : resolve(gitDir, common);
  return dirname(commonGitDir);
}

function locate(start: string, stopAt: string | undefined): Checkout {
  const fence = stopAt === undefined ? null : comparableCheckout(stopAt);
  let dir = start;
  for (;;) {
    const marker = resolve(dir, ".git");
    if (existsSync(marker)) {
      const worktree = comparableOnDisk(dir);
      if (statSync(marker).isDirectory())
        return { workspace: worktree, worktree };
      const main = mainCheckoutOf(dir, marker);
      return {
        workspace: main === null ? worktree : comparableOnDisk(main),
        worktree,
      };
    }
    const parent = dirname(dir);
    if (parent === dir || comparableCheckout(dir) === fence) break;
    dir = parent;
  }
  const self = comparableOnDisk(start);
  return { workspace: self, worktree: self };
}

/**
 * The checkout containing `cwd`, in comparable form. Walks up to the first
 * `.git`; a directory outside any checkout is its own workspace. Answers are
 * remembered for the life of the process. `stopAt` fences the walk (tests).
 */
export function resolveCheckout(
  cwd: string,
  opts: { stopAt?: string } = {},
): Checkout {
  const start = resolve(cwd);
  const key = `${start}\n${opts.stopAt ?? ""}`;
  const known = resolved.get(key);
  if (known) return known;
  let checkout: Checkout;
  try {
    checkout = locate(start, opts.stopAt);
  } catch {
    const self = comparableOnDisk(start);
    checkout = { workspace: self, worktree: self };
  }
  resolved.set(key, checkout);
  return checkout;
}
