/** Bun host boundary. Registry readers stay Node-importable; every production writer shares this lock. */
import { Database } from "bun:sqlite";
import { lstatSync } from "node:fs";
import { join } from "node:path";
import { windowsConfigLeafKind } from "../config/transaction-windows";
import { canonicalTrustedDirectory } from "../trusted-directory";
import {
  type CreateRequest,
  createWorktree,
  type Outcome,
  type RegistryDeps,
  removeWorktree,
} from "./worktrees";

const held = new Set<string>();
const refusal = <T>(): Outcome<T> => ({
  ok: false,
  error:
    "Worktree registry is busy or could not be safely locked; no registry mutation was started.",
});

/** No waiting, awaits, nested domain locks, or async callback. The OS releases a dead holder's transaction. */
export function withWorktreeRegistryLock<T>(
  main: string,
  work: () => Outcome<T>,
): Outcome<T> {
  let database: Database | undefined, key: string | undefined;
  try {
    const root = canonicalTrustedDirectory(main);
    const directory = join(root, ".git");
    if (
      canonicalTrustedDirectory(directory) !== directory ||
      !lstatSync(directory).isDirectory()
    )
      return refusal();
    const file = join(directory, "agent-forge-worktrees.lock.db");
    key = process.platform === "win32" ? file.toLowerCase() : file;
    if (held.has(key) || work.constructor.name === "AsyncFunction")
      return refusal();
    const check = () => {
      try {
        const found = lstatSync(file);
        if (
          !found.isFile() ||
          found.isSymbolicLink() ||
          found.nlink !== 1 ||
          (process.platform === "win32" &&
            windowsConfigLeafKind(file) !== "plain")
        )
          throw Error("Unsafe registry lock");
        return `${found.dev}:${found.ino}`;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        return null;
      }
    };
    const before = check();
    database = new Database(file, { create: true });
    database.exec("PRAGMA busy_timeout = 0");
    database.exec("BEGIN EXCLUSIVE");
    const acquired = check();
    if (
      !acquired ||
      (before !== null && acquired !== before) ||
      canonicalTrustedDirectory(directory) !== directory
    ) {
      database.close();
      database = undefined;
      return refusal();
    }
    held.add(key);
  } catch {
    try {
      database?.close();
    } catch {
      /* No callback ran. */
    }
    return refusal();
  }
  try {
    return work();
  } finally {
    if (key) held.delete(key);
    try {
      database?.exec("ROLLBACK");
    } catch {
      /* Closing still releases the transaction. */
    }
    try {
      database?.close();
    } catch {
      /* The OS retains ownership until process release. */
    }
  }
}

export function createLockedWorktree(
  main: string,
  from: string,
  request: CreateRequest,
  deps: Partial<RegistryDeps> = {},
) {
  return withWorktreeRegistryLock(main, () =>
    createWorktree(main, from, request, deps),
  );
}
export function removeLockedWorktree(
  main: string,
  id: string,
  options: { force: boolean },
  deps: Partial<RegistryDeps> = {},
) {
  return withWorktreeRegistryLock(main, () =>
    removeWorktree(main, id, options, deps),
  );
}
