import { randomBytes } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

/** What a running hearth publishes so others can find and reuse it. */
export interface HearthLock {
  pid: number;
  port: number;
  root: string;
  startedAt: string;
  /** Path of the operator token file; the token itself never goes in the lock. */
  tokenFile: string;
  /** Id of the Vite plugin instance currently responsible for stopping it. */
  supervisor?: string;
}

export type AcquireResult =
  | { kind: "acquired" }
  | { kind: "held"; lock: HearthLock };

export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * The lock at `path`, read by its path with no check: for the hearth's own
 * bookkeeping. A client that sends the operator token to the port a lock
 * names reads it with `readHomeFile` (`home-guard.ts`) and parses it with
 * `parseLock`.
 */
export function readLock(path: string): HearthLock | null {
  try {
    return parseLock(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/** Whether two locks name the same hearth: every field the hearth wrote. */
export function sameLock(a: HearthLock | null, b: HearthLock | null): boolean {
  return (
    a !== null &&
    b !== null &&
    a.pid === b.pid &&
    a.port === b.port &&
    a.root === b.root &&
    a.startedAt === b.startedAt &&
    a.tokenFile === b.tokenFile
  );
}

/** A lock from the text of a lock file, or null when it is not one. */
export function parseLock(text: string): HearthLock | null {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null) return null;
    const candidate = parsed as Record<string, unknown>;
    if (
      typeof candidate["pid"] !== "number" ||
      typeof candidate["port"] !== "number" ||
      typeof candidate["root"] !== "string" ||
      typeof candidate["startedAt"] !== "string" ||
      typeof candidate["tokenFile"] !== "string"
    ) {
      return null;
    }
    const lock: HearthLock = {
      pid: candidate["pid"],
      port: candidate["port"],
      root: candidate["root"],
      startedAt: candidate["startedAt"],
      tokenFile: candidate["tokenFile"],
    };
    if (typeof candidate["supervisor"] === "string") {
      lock.supervisor = candidate["supervisor"];
    }
    return lock;
  } catch {
    return null;
  }
}

/**
 * Claim the lock with an exclusive create. A lock held by a live pid is
 * returned untouched; one whose pid is dead (or unreadable) is replaced.
 */
export function acquireLock(path: string, lock: HearthLock): AcquireResult {
  mkdirSync(dirname(path), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(path, JSON.stringify(lock), { flag: "wx" });
      return { kind: "acquired" };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const existing = readLock(path);
    if (existing && isPidAlive(existing.pid)) {
      return { kind: "held", lock: existing };
    }
    rmSync(path, { force: true });
  }
  const winner = readLock(path);
  if (winner) return { kind: "held", lock: winner };
  throw new Error(`Could not acquire hearth lock at ${path}`);
}

/**
 * Rewrite the lock (write-then-rename) as `lock` with a patch applied:
 * `lock` is the one the caller read with the check (`readHomeLock`), and
 * nothing read here by the path goes into what is written (`x1gs.3.38`). A
 * lock read again by its path could be someone else's: a folder above the
 * home swapped in for that read and back for the write would have this
 * user's own process write their port into the home, as a file of this
 * user's, which every check passes. The path is read only to leave alone a
 * lock that no longer names that hearth (closed, or started again). Null
 * then; the lock written otherwise. The temp file is new (`wx`), named at
 * random and, where modes count, this user's only.
 */
export function updateLock(
  path: string,
  lock: HearthLock,
  patch: Partial<Pick<HearthLock, "supervisor">>,
): HearthLock | null {
  if (!sameLock(readLock(path), lock)) return null;
  const next = { ...lock, ...patch };
  const temp = `${path}.${process.pid}-${randomBytes(6).toString("hex")}.tmp`;
  writeFileSync(temp, JSON.stringify(next), { flag: "wx", mode: 0o600 });
  try {
    renameSync(temp, path);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
  return next;
}

/** Remove the lock only if it still names `pid`. */
export function releaseLock(path: string, pid: number): void {
  const current = readLock(path);
  if (current?.pid === pid) rmSync(path, { force: true });
}
