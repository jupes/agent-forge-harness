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

export function readLock(path: string): HearthLock | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
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

/** Rewrite the lock in place (write-then-rename) with a patch applied. */
export function updateLock(
  path: string,
  patch: Partial<Pick<HearthLock, "supervisor">>,
): HearthLock | null {
  const current = readLock(path);
  if (!current) return null;
  const next = { ...current, ...patch };
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(next));
  renameSync(temp, path);
  return next;
}

/** Remove the lock only if it still names `pid`. */
export function releaseLock(path: string, pid: number): void {
  const current = readLock(path);
  if (current?.pid === pid) rmSync(path, { force: true });
}
