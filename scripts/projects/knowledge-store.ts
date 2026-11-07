import { lstatSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { windowsConfigLeafKind } from "../config/transaction-windows";
import { ConversationError } from "../conversations/error";
import { ensurePrivateHome, readHomeFileBounded } from "../hearth/home-guard";
import { writeOwnerOnly } from "../hearth/token";
import { withQueueLock } from "../scheduler/queue-lock";
import {
  canonicalKnowledgeRefresh,
  KNOWLEDGE_LIMITS,
  knowledgeReceiptSchema,
  knowledgeRefreshRequestSchema,
} from "./knowledge-protocol";
import { knowledgeDigest } from "./knowledge-source";
import { isProjectId } from "./store";

const hash = z.string().regex(/^[a-f0-9]{64}$/),
  address = z.string().min(1).max(4096),
  uint = z.string().regex(/^\d+$/);
const snapshotSchema = z
  .object({
    file: address,
    parent: z.object({ path: address, dev: uint, ino: uint }).strict(),
    leaf: z
      .object({
        dev: uint,
        ino: uint,
        size: uint,
        mtimeNs: z.string().regex(/^-?\d+$/),
        ctimeNs: z.string().regex(/^-?\d+$/),
        nlink: z.string().regex(/^1$/),
      })
      .strict()
      .nullable(),
    bytes: z.string().max(KNOWLEDGE_LIMITS.documentBytes).nullable(),
    hash: hash.nullable(),
    mtimeMs: z.number().finite().nullable(),
  })
  .strict()
  .refine((value) =>
    value.bytes === null
      ? value.leaf === null && value.hash === null && value.mtimeMs === null
      : value.leaf !== null &&
        value.hash === knowledgeDigest(value.bytes) &&
        value.mtimeMs !== null &&
        Buffer.byteLength(value.bytes) <= KNOWLEDGE_LIMITS.documentBytes,
  );
const originalSchema = z
  .object({
    projectId: z.string().refine(isProjectId),
    request: knowledgeRefreshRequestSchema,
    requestHash: hash,
    authoritySeal: z.string().min(1).max(16384),
    name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/),
    membershipHash: hash,
    smith: z
      .object({
        name: z.string().min(1).max(128),
        provider: z.literal("claude"),
        model: z.string().min(1).max(256),
        effort: z.string().min(1).max(64),
        enabled: z.literal(true),
        tags: z.array(z.string().max(128)).max(64),
      })
      .strict(),
    profileHash: hash,
    sourceCommit: z.string().regex(/^[a-f0-9]{40}([a-f0-9]{24})?$/),
    evidenceHash: hash,
    prior: snapshotSchema,
    createdAt: z.iso.datetime(),
  })
  .strict()
  .refine(
    (value) =>
      value.requestHash ===
      knowledgeDigest(
        canonicalKnowledgeRefresh(value.projectId, value.request),
      ),
  );
const rowSchema = z
  .object({
    original: originalSchema,
    sealHash: hash,
    receipt: knowledgeReceiptSchema,
    candidate: z.string().max(KNOWLEDGE_LIMITS.documentBytes).nullable(),
    publication: snapshotSchema.nullable(),
    attemptedAt: z.iso.datetime().nullable(),
    candidateSavedAt: z.iso.datetime().nullable(),
    publicationAttemptedAt: z.iso.datetime().nullable(),
  })
  .strict()
  .refine((row) => {
    const { original: o, receipt: r } = row;
    return (
      row.sealHash === knowledgeDigest(JSON.stringify(o)) &&
      r.projectId === o.projectId &&
      r.requestId === o.request.requestId &&
      r.requestHash === o.requestHash &&
      r.repositoryKey === o.request.repositoryKey &&
      r.sourceCommit === o.sourceCommit &&
      r.evidenceHash === o.evidenceHash &&
      (row.candidate === null
        ? r.candidateHash === null &&
          !["candidate-saved", "publishing", "confirmed"].includes(r.state)
        : Buffer.byteLength(row.candidate) <= KNOWLEDGE_LIMITS.documentBytes &&
          r.candidateHash === knowledgeDigest(row.candidate)) &&
      (r.state === "confirmed"
        ? r.confirmedAt !== null
        : r.confirmedAt === null) &&
      (r.state === "reserved"
        ? row.attemptedAt === null
        : row.attemptedAt !== null) &&
      (row.candidate === null
        ? row.candidateSavedAt === null &&
          row.publication === null &&
          row.publicationAttemptedAt === null
        : row.candidateSavedAt !== null) &&
      (r.state !== "publishing" ||
        (row.publication !== null && row.publicationAttemptedAt !== null)) &&
      (r.state !== "candidate-saved" || row.publicationAttemptedAt === null) &&
      (r.state !== "failed" ||
        (row.candidate !== null && row.publicationAttemptedAt === null)) &&
      r.state !== "refused"
    );
  });
const stateSchema = z
  .object({
    version: z.literal(1),
    records: z.array(rowSchema).max(KNOWLEDGE_LIMITS.operations),
  })
  .strict()
  .refine(
    (state) =>
      new Set(
        state.records.map(
          (row) =>
            row.original.projectId + "/" + row.original.request.requestId,
        ),
      ).size === state.records.length,
  );
export type KnowledgeOriginal = z.infer<typeof originalSchema>;
export const checkedKnowledgeOriginal = (value: unknown): KnowledgeOriginal =>
  originalSchema.parse(value);
export type KnowledgeRow = z.infer<typeof rowSchema>;
type KnowledgeState = z.infer<typeof stateSchema>;
const MAX_BYTES = 8 * 1024 * 1024,
  RESERVE_BYTES = 6 * KNOWLEDGE_LIMITS.documentBytes + 65536;
const unsettled = (row: KnowledgeRow) =>
  !["confirmed", "refused", "failed"].includes(row.receipt.state);
const fail = (): never => {
  throw new ConversationError(
    503,
    "Knowledge refresh ownership could not be completely verified. Saved originals were retained; no automatic generation or publication is allowed.",
  );
};
export function knowledgeOperationHash(
  projectId: string,
  request: z.infer<typeof knowledgeRefreshRequestSchema>,
) {
  return knowledgeDigest(canonicalKnowledgeRefresh(projectId, request));
}

/** Pure bounded inventory read; missing is empty, malformed/unprotected is unknown to its caller. */
export function readKnowledgeInventory(home: string): KnowledgeRow[] {
  const file = join(home, "knowledge-refresh", "operations.json"),
    found = readHomeFileBounded(home, file, MAX_BYTES);
  if (found.problem !== null) return fail();
  if (found.text === null) return [];
  try {
    return stateSchema.parse(JSON.parse(found.text)).records;
  } catch {
    return fail();
  }
}

/** Serializes private identity changes only; model execution never holds this lease. */
export function createKnowledgeStore(home: string) {
  const file = join(home, "knowledge-refresh", "operations.json"),
    lock = join(home, "knowledge-refresh.lock.db");
  const find = (state: KnowledgeState, projectId: string, requestId: string) =>
    state.records.find(
      (row) =>
        row.original.projectId === projectId &&
        row.original.request.requestId === requestId,
    );
  return {
    read(projectId: string, requestId: string) {
      return find(
        { version: 1, records: readKnowledgeInventory(home) },
        projectId,
        requestId,
      );
    },
    async locked<T>(
      work: (state: KnowledgeState, save: () => void) => Promise<T>,
    ): Promise<T> {
      ensurePrivateHome(home);
      try {
        const info = lstatSync(lock);
        if (
          !info.isFile() ||
          info.isSymbolicLink() ||
          info.nlink !== 1 ||
          (process.platform === "win32" &&
            windowsConfigLeafKind(lock) !== "plain")
        )
          return fail();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const held = await withQueueLock(
        lock,
        async () => {
          const state: KnowledgeState = {
            version: 1,
            records: readKnowledgeInventory(home),
          };
          const save = () => {
            const checked = stateSchema.parse(state),
              text = JSON.stringify(checked),
              reserved =
                checked.records.filter(
                  (row) => unsettled(row) && row.candidate === null,
                ).length * RESERVE_BYTES;
            if (Buffer.byteLength(text) + reserved > MAX_BYTES)
              throw new ConversationError(
                409,
                "The knowledge journal has no reserved capacity for another complete candidate. No generation was dispatched.",
              );
            writeOwnerOnly(file, text);
            const verified = readHomeFileBounded(home, file, MAX_BYTES);
            if (verified.problem !== null || verified.text !== text)
              return fail();
          };
          return work(state, save);
        },
        { waitMs: 1000 },
      );
      if (!held.ok) return fail();
      return held.value;
    },
    find,
  };
}
