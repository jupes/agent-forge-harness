import { createHash } from "node:crypto";
import {
  type BigIntStats,
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import { windowsConfigLeafKind } from "../config/transaction-windows";
import { nativeWindowsAcl } from "../hearth/acl-windows";
import {
  posixWriteFinding,
  readHomeFile,
  readHomeFileBounded,
  windowsWriteFinding,
} from "../hearth/home-guard";
import { writeOwnerOnly } from "../hearth/token";
import { hasDuplicateObjectKeys } from "../json-object-keys";
import { withQueueLock } from "../scheduler/queue-lock";
import { registryPathKey } from "../scheduler/worktrees";
import { canonicalTrustedDirectory } from "../trusted-directory";
import {
  canonicalCleanupRequest,
  cleanupRequestSchema,
} from "./worktree-cleanup-protocol";

const stamp = z.iso.datetime();
const original = z
  .object({
    version: z.literal(1),
    projectId: z
      .string()
      .regex(
        /^project-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,
      ),
    request: cleanupRequestSchema,
    requestHash: z.string().regex(/^[a-f0-9]{64}$/),
    createdAt: stamp,
    audit: z
      .object({
        eventId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
        ulid: z.string().regex(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/),
        ts: stamp,
      })
      .strict(),
  })
  .strict()
  .refine((row) => {
    const { repository, expectedRecord: target } = row.request;
    return (
      row.requestHash ===
        createHash("sha256")
          .update(canonicalCleanupRequest(row.projectId, row.request))
          .digest("hex") &&
      isAbsolute(repository) &&
      isAbsolute(target.path) &&
      registryPathKey(target.path) ===
        registryPathKey(join(repository, "trees", target.id))
    );
  });
const row = z
  .object({
    original,
    // Only the trusted direct-result marker can settle a confirmed original.
    phase: z.enum(["reserved", "attempted", "unknown", "refused", "confirmed"]),
    attemptedAt: stamp.nullable(),
    endedAt: stamp.nullable(),
    reason: z.string().min(1).max(1000).nullable(),
    outcome: z.literal("reviewed-remove-returned-ok").nullable(),
  })
  .strict()
  .refine((entry) => {
    const created = Date.parse(entry.original.createdAt);
    if (entry.attemptedAt !== null && Date.parse(entry.attemptedAt) < created)
      return false;
    if (entry.phase === "confirmed")
      return (
        entry.attemptedAt !== null &&
        entry.endedAt !== null &&
        Date.parse(entry.endedAt) >= Date.parse(entry.attemptedAt) &&
        entry.reason === null &&
        entry.outcome === "reviewed-remove-returned-ok"
      );
    if (entry.outcome !== null) return false;
    if (entry.phase === "refused")
      return (
        entry.attemptedAt === null &&
        entry.endedAt !== null &&
        Date.parse(entry.endedAt) >= created &&
        entry.reason !== null
      );
    if (entry.endedAt !== null) return false;
    return entry.phase === "unknown"
      ? entry.reason !== null
      : entry.reason === null &&
          (entry.phase === "reserved") === (entry.attemptedAt === null);
  });
const journal = z
  .object({ version: z.literal(1), records: z.array(row).max(1000) })
  .strict()
  .refine(
    (state) =>
      new Set(state.records.map((entry) => entry.original.request.requestId))
        .size === state.records.length,
  );

/** Complete raw read: no lease, initialization, repair, or cleanup effect. */
export function readWorktreeCleanupInventory(home: string) {
  const directory = join(home, "project-worktree-cleanup");
  if (readHomeFile(home).problem !== null)
    throw Error("Unprotected cleanup home");
  let before: BigIntStats;
  try {
    before = lstatSync(directory, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  if (
    !before.isDirectory() ||
    before.isSymbolicLink() ||
    registryPathKey(canonicalTrustedDirectory(directory)) !==
      registryPathKey(directory)
  )
    throw Error("Unsafe cleanup namespace");
  const found = readHomeFileBounded(
    directory,
    join(directory, "operations.json"),
    2 * 1024 * 1024,
  );
  if (
    found.problem !== null ||
    found.text === null ||
    hasDuplicateObjectKeys(found.text)
  )
    throw Error("Cleanup history is missing or unreadable");
  let raw: unknown;
  try {
    raw = JSON.parse(found.text);
  } catch {
    throw Error("Malformed cleanup history");
  }
  const parsed = journal.parse(raw);
  const after = lstatSync(directory, { bigint: true });
  if (
    !after.isDirectory() ||
    after.isSymbolicLink() ||
    after.dev !== before.dev ||
    after.ino !== before.ino
  )
    throw Error("Cleanup namespace changed during its read");
  return parsed.records;
}

export type CleanupRow = z.infer<typeof row>;
export interface WorktreeCleanupLease {
  read(): CleanupRow[];
}

/** Host-only lease; the callback receives no persistence or removal capability. */
export async function withWorktreeCleanupLease<T>(
  home: string,
  work: (scope: WorktreeCleanupLease) => Promise<T>,
  controls: { persist?: typeof writeOwnerOnly } = {},
): Promise<T> {
  const persist = controls.persist ?? writeOwnerOnly;
  const directory = join(home, "project-worktree-cleanup");
  const file = join(directory, "operations.json");
  const lock = join(directory, "write.lock.db");
  const directoryIdentity = (path: string) => {
    const info = lstatSync(path, { bigint: true });
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      readHomeFile(path).problem !== null ||
      registryPathKey(canonicalTrustedDirectory(path)) !== registryPathKey(path)
    )
      throw Error("Cleanup lease requires protected canonical directories");
    return `${info.dev}:${info.ino}`;
  };
  const homePin = directoryIdentity(home);
  let created = false;
  try {
    mkdirSync(directory, { mode: 0o700 });
    created = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const directoryPin = directoryIdentity(directory);
  if (created) {
    persist(file, JSON.stringify({ version: 1, records: [] }));
    if (readWorktreeCleanupInventory(home).length !== 0)
      throw Error("Cleanup initialization could not be confirmed");
  } else readWorktreeCleanupInventory(home);
  try {
    closeSync(openSync(lock, "wx", 0o600));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const lockIdentity = () => {
    const info = lstatSync(lock, { bigint: true });
    const acl = process.platform === "win32" ? nativeWindowsAcl() : null;
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.nlink !== 1n ||
      info.size > 1024n * 1024n ||
      (acl
        ? windowsConfigLeafKind(lock) !== "plain" ||
          windowsWriteFinding(acl.read(lock), "file", acl.userSid()) !== null
        : posixWriteFinding(lstatSync(lock), process.getuid?.() ?? -1) !== null)
    )
      throw Error("Unsafe cleanup lease file");
    return `${info.dev}:${info.ino}`;
  };
  const lockPin = lockIdentity();
  const result = await withQueueLock(
    lock,
    async () => {
      if (
        directoryIdentity(home) !== homePin ||
        directoryIdentity(directory) !== directoryPin ||
        lockIdentity() !== lockPin
      )
        throw Error("Cleanup lease identity changed");
      const baseline = readWorktreeCleanupInventory(home);
      let active = true;
      const scope = Object.freeze({
        read: () => {
          if (!active) throw Error("Cleanup lease has ended");
          return structuredClone(baseline);
        },
      });
      try {
        return await work(scope);
      } finally {
        active = false;
      }
    },
    { waitMs: 1000 },
  );
  if (!result.ok) throw Error("Cleanup journal is busy or unavailable");
  return result.value;
}
