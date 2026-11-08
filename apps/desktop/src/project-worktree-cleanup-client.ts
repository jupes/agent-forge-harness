import { z } from "zod";
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
