import { z } from "zod";
import { hasDuplicateObjectKeys } from "../../../scripts/json-object-keys";
import {
  canonicalCleanupRequest,
  cleanupReceiptSchema,
  cleanupRequestSchema,
} from "../../../scripts/projects/worktree-cleanup-protocol";
import { cleanupReviewSchema } from "../../../scripts/projects/worktree-cleanup-review-protocol";

export const cleanupBrowserOriginalSchema = z
  .object({
    projectId: cleanupReceiptSchema.shape.projectId,
    review: cleanupReviewSchema.options[0],
    request: cleanupRequestSchema,
    requestHash: cleanupReceiptSchema.shape.requestHash,
  })
  .strict()
  .refine(
    (original) =>
      original.projectId === original.review.projectId &&
      canonicalCleanupRequest(original.projectId, original.request) ===
        canonicalCleanupRequest(original.projectId, {
          ...original.review,
          requestId: original.request.requestId,
        }),
    { message: "Displayed cleanup review does not match the full original" },
  );
export type CleanupBrowserOriginal = z.infer<
  typeof cleanupBrowserOriginalSchema
>;

/** Exact native values; the displayed observation time is part of the saved original. */
export function sameCleanupOriginal(
  left: CleanupBrowserOriginal,
  right: CleanupBrowserOriginal,
): boolean {
  return (
    left.projectId === right.projectId &&
    left.requestHash === right.requestHash &&
    left.review.asOf === right.review.asOf &&
    left.review.projectId === right.review.projectId &&
    left.review.worktreeId === right.review.worktreeId &&
    canonicalCleanupRequest(left.projectId, left.request) ===
      canonicalCleanupRequest(right.projectId, right.request) &&
    canonicalCleanupRequest(left.projectId, {
      ...left.review,
      requestId: left.request.requestId,
    }) ===
      canonicalCleanupRequest(right.projectId, {
        ...right.review,
        requestId: right.request.requestId,
      })
  );
}
export const cleanupBrowserRecordSchema = z
  .object({
    original: cleanupBrowserOriginalSchema,
    receipt: cleanupReceiptSchema.nullable(),
  })
  .strict()
  .refine(
    ({ original, receipt }) => {
      if (receipt === null) return true;
      if (
        receipt.projectId !== original.projectId ||
        receipt.requestHash !== original.requestHash ||
        canonicalCleanupRequest(receipt.projectId, receipt) !==
          canonicalCleanupRequest(original.projectId, original.request)
      )
        return false;
      const audited = Date.parse(receipt.audit.ts);
      return (
        (receipt.attemptedAt === null ||
          audited <= Date.parse(receipt.attemptedAt)) &&
        (receipt.endedAt === null || audited <= Date.parse(receipt.endedAt))
      );
    },
    {
      message:
        "Stored cleanup receipt does not match its original or audit chronology",
    },
  );
export type CleanupBrowserRecord = z.infer<typeof cleanupBrowserRecordSchema>;

export const cleanupBrowserMarkerSchema = z
  .object({
    version: z.literal(1),
    authorityKey: z.string().min(1).max(2048),
  })
  .strict();
export const cleanupBrowserInventorySchema = cleanupBrowserMarkerSchema
  .extend({
    records: z.array(cleanupBrowserRecordSchema).max(100),
    activeRequestId: cleanupRequestSchema.shape.requestId.nullable(),
  })
  .strict()
  .refine(
    (inventory) => {
      const seen = new Set<string>();
      let unresolved: string | null = null;
      for (const row of inventory.records) {
        const id = row.original.request.requestId;
        if (seen.has(id)) return false;
        seen.add(id);
        if (row.receipt === null || row.receipt.state === "unknown") {
          if (unresolved !== null) return false;
          unresolved = id;
        }
      }
      return inventory.activeRequestId === unresolved;
    },
    { message: "Cleanup inventory has conflicting active ownership" },
  );
export type CleanupBrowserInventory = z.infer<
  typeof cleanupBrowserInventorySchema
>;

function parseCleanupRaw(source: string, maxBytes: number): unknown {
  if (
    typeof source !== "string" ||
    source.length > maxBytes ||
    new TextEncoder().encode(source).byteLength > maxBytes
  )
    throw Error("Cleanup recovery metadata exceeds its byte limit");
  try {
    if (hasDuplicateObjectKeys(source))
      throw Error("Duplicate decoded JSON key");
    return JSON.parse(source);
  } catch {
    throw Error("Cleanup recovery metadata is malformed or has duplicate keys");
  }
}
/** Read-only: absence of both keys is distinct from damaged initialized evidence. */
export async function readCleanupBrowserInventory(
  rawMarker: string | null,
  rawInventory: string | null,
  authorityKey: string,
  hash: (text: string) => Promise<string>,
): Promise<CleanupBrowserInventory | null> {
  cleanupBrowserMarkerSchema.shape.authorityKey.parse(authorityKey);
  if (rawMarker === null && rawInventory === null) return null;
  if (rawMarker === null || rawInventory === null)
    throw Error("Initialized cleanup recovery metadata is missing");
  const marker = cleanupBrowserMarkerSchema.parse(
    parseCleanupRaw(rawMarker, 16384),
  );
  const raw = parseCleanupRaw(rawInventory, 1048576);
  if (
    raw &&
    typeof raw === "object" &&
    "records" in raw &&
    Array.isArray(raw.records) &&
    raw.records.length > 100
  )
    throw Error("Cleanup inventory exceeds its row limit");
  const inventory = cleanupBrowserInventorySchema.parse(raw);
  if (
    marker.authorityKey !== authorityKey ||
    inventory.authorityKey !== authorityKey
  )
    throw Error("Cleanup recovery authority changed");
  for (const row of inventory.records) {
    const original = row.original;
    if (
      (await hash(
        canonicalCleanupRequest(original.projectId, original.request),
      )) !== original.requestHash
    )
      throw Error("Cleanup recovery original hash does not match");
  }
  return inventory;
}
