import { createHash } from "node:crypto";
import { type BigIntStats, lstatSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import { readHomeFile, readHomeFileBounded } from "../hearth/home-guard";
import { hasDuplicateObjectKeys } from "../json-object-keys";
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
        ulid: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/),
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
    // Terminal variants remain unsupported/unknown until their evidence contract is implemented.
    phase: z.enum(["reserved", "attempted", "unknown"]),
    attemptedAt: stamp.nullable(),
    endedAt: z.null(),
    reason: z.string().min(1).max(1000).nullable(),
    outcome: z.null(),
  })
  .strict()
  .refine(
    (entry) =>
      (entry.attemptedAt === null ||
        Date.parse(entry.attemptedAt) >=
          Date.parse(entry.original.createdAt)) &&
      (entry.phase === "unknown"
        ? entry.reason !== null
        : entry.reason === null &&
          (entry.phase === "reserved") === (entry.attemptedAt === null)),
  );
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
