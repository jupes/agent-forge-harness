import { z } from "zod";
import {
  type ProjectCheckpointReviewBinding,
  type ProjectCheckpointReviewScope,
  projectCheckpointReviewBindingSchema,
  projectCheckpointReviewScopeSchema,
} from "./project-checkpoint-reviews";

export const CHECKPOINT_SUBMISSION_MAX_RECORDS = 100;
export const CHECKPOINT_SUBMISSION_MAX_ORIGINAL_BYTES = 64 * 1024;
export const CHECKPOINT_WITHDRAW_MAX_ORIGINAL_BYTES = 32 * 1024;
export const CHECKPOINT_SUBMISSION_MAX_RECORD_BYTES = 68 * 1024;
export const CHECKPOINT_WITHDRAW_MAX_RECORD_BYTES = 36 * 1024;
const requestIdSchema = z
  .uuid()
  .refine((value) => value === value.toLowerCase());
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const generationSchema = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER - 1);
const gitObjectSchema = z
  .string()
  .regex(/^[a-f0-9]{40}$/)
  .refine((value) => value !== "0".repeat(40));
export const projectCheckpointSourceVersionSchema = z
  .object({
    kind: z.literal("committed-git-snapshot"),
    commit: gitObjectSchema,
    tree: gitObjectSchema,
  })
  .strict();
export type ProjectCheckpointSourceVersion = z.infer<
  typeof projectCheckpointSourceVersionSchema
>;

export const projectCheckpointSubmissionPublishSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal("publish"),
    requestId: requestIdSchema,
    binding: projectCheckpointReviewBindingSchema,
    sourceVersion: projectCheckpointSourceVersionSchema,
    expectedSubmissionGeneration: generationSchema,
  })
  .strict();
export const projectCheckpointSubmissionWithdrawSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal("withdraw"),
    requestId: requestIdSchema,
    scope: projectCheckpointReviewScopeSchema,
    targetSubmissionRequestId: requestIdSchema,
    targetOriginalHash: hashSchema,
    expectedSubmissionGeneration: generationSchema,
  })
  .strict();
export const projectCheckpointSubmissionOriginalSchema = z
  .discriminatedUnion("kind", [
    projectCheckpointSubmissionPublishSchema,
    projectCheckpointSubmissionWithdrawSchema,
  ])
  .superRefine((original, context) => {
    const limit =
      original.kind === "withdraw"
        ? CHECKPOINT_WITHDRAW_MAX_ORIGINAL_BYTES
        : CHECKPOINT_SUBMISSION_MAX_ORIGINAL_BYTES;
    if (new TextEncoder().encode(JSON.stringify(original)).byteLength > limit)
      context.addIssue({
        code: "custom",
        message: "The source original exceeds its byte limit",
      });
  });
export type ProjectCheckpointSubmissionOriginal = z.infer<
  typeof projectCheckpointSubmissionOriginalSchema
>;
export type ProjectCheckpointSubmissionPublish = z.infer<
  typeof projectCheckpointSubmissionPublishSchema
>;
export type ProjectCheckpointSubmissionWithdraw = z.infer<
  typeof projectCheckpointSubmissionWithdrawSchema
>;

export function projectCheckpointSubmissionScope(
  original: ProjectCheckpointSubmissionOriginal,
): ProjectCheckpointReviewScope {
  if (original.kind === "withdraw") return { ...original.scope };
  const { projectId, workspacePath, runSlug, beadId } = original.binding;
  return { projectId, workspacePath, runSlug, beadId };
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (typeof value === "object" && value !== null)
    return (
      "{" +
      Object.keys(value)
        .sort()
        .map(
          (key) =>
            JSON.stringify(key) +
            ":" +
            canonical((value as Record<string, unknown>)[key]),
        )
        .join(",") +
      "}"
    );
  const encoded = JSON.stringify(value);
  if (encoded === undefined)
    throw new TypeError("The source original must be JSON data.");
  return encoded;
}
export function projectCheckpointSubmissionOriginalJson(
  original: ProjectCheckpointSubmissionOriginal,
): string {
  return canonical(projectCheckpointSubmissionOriginalSchema.parse(original));
}

export const projectCheckpointSubmissionRecordSchema = z
  .object({
    original: projectCheckpointSubmissionOriginalSchema,
    originalHash: hashSchema,
    receipt: z
      .object({
        schemaVersion: z.literal(1),
        requestId: requestIdSchema,
        originalHash: hashSchema,
        scope: projectCheckpointReviewScopeSchema,
        state: z.literal("applied"),
        observedGeneration: generationSchema,
        resultingGeneration: z
          .number()
          .int()
          .positive()
          .max(Number.MAX_SAFE_INTEGER),
        auditEventId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
        appliedAt: z.iso.datetime(),
        reviewScopeHash: hashSchema.nullable(),
      })
      .strict(),
  })
  .strict()
  .superRefine((record, context) => {
    const { original, originalHash, receipt } = record;
    if (
      receipt.requestId !== original.requestId ||
      receipt.originalHash !== originalHash ||
      canonical(receipt.scope) !==
        canonical(projectCheckpointSubmissionScope(original)) ||
      receipt.observedGeneration !== original.expectedSubmissionGeneration ||
      receipt.resultingGeneration !== receipt.observedGeneration + 1 ||
      (original.kind === "publish"
        ? receipt.reviewScopeHash === null
        : receipt.reviewScopeHash !== null)
    )
      context.addIssue({
        code: "custom",
        message: "The source receipt does not match its immutable original",
      });
    const limit =
      original.kind === "withdraw"
        ? CHECKPOINT_WITHDRAW_MAX_RECORD_BYTES
        : CHECKPOINT_SUBMISSION_MAX_RECORD_BYTES;
    if (new TextEncoder().encode(JSON.stringify(record)).byteLength > limit)
      context.addIssue({
        code: "custom",
        message: "The complete source record exceeds its byte limit",
      });
  });
export type ProjectCheckpointSubmissionRecord = z.infer<
  typeof projectCheckpointSubmissionRecordSchema
>;
export type ProjectCheckpointSubmissionSnapshot = Readonly<{
  binding: ProjectCheckpointReviewBinding;
  sourceVersion: ProjectCheckpointSourceVersion;
}>;
