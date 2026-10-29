import { z } from "zod";
import {
  REVIEW_NOTE_LIMIT,
  reviewCommentFor,
} from "../scripts/dashboard/forge-run-model";
import { isValidSlug } from "../scripts/forge/runs";
import { parseBeadsIssueId } from "../scripts/run-correlation";

export const PROJECT_CHECKPOINT_REVIEW_SCHEMA_VERSION: 1 = 1;
export const PROJECT_CHECKPOINT_REVIEW_MAX_NOTE_CHARACTERS = REVIEW_NOTE_LIMIT;
export const PROJECT_CHECKPOINT_REVIEW_MAX_ORIGINAL_BYTES = 64 * 1024;
export const PROJECT_CHECKPOINT_REVIEW_MAX_JOURNAL_BYTES = 2 * 1024 * 1024;
export const PROJECT_CHECKPOINT_REVIEW_MAX_JOURNAL_RECORDS = 100;
export const PROJECT_CHECKPOINT_REVIEW_MAX_BODY_BYTES = 16 * 1024;

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const requestIdSchema = z
  .uuid()
  .refine((value) => value === value.toLowerCase());
const projectIdSchema = z
  .string()
  .regex(
    /^project-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
const runSlugSchema = z.string().refine(isValidSlug);
const beadIdSchema = z
  .string()
  .refine((value) => parseBeadsIssueId(value) === value);
function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 32 || code === 127) return true;
  }
  return false;
}
const boundedPathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => !hasControlCharacters(value));
const commentIdSchema = z
  .string()
  .min(1)
  .max(256)
  .refine(
    (value) => value === value.trim() && !hasControlCharacters(value),
  );
const timestampSchema = z.iso.datetime();
const decisionSchema = z.enum(["approve", "request-changes"]);
const normalizedNoteSchema = z
  .string()
  .transform((value) => value.trim())
  .pipe(z.string().max(PROJECT_CHECKPOINT_REVIEW_MAX_NOTE_CHARACTERS))
  .refine((value) => !value.includes(String.fromCharCode(0)), {
    message: "note must not hold a NUL character",
  });

export const projectCheckpointReviewBindingSchema = z
  .object({
    projectId: projectIdSchema,
    workspacePath: boundedPathSchema,
    checkout: boundedPathSchema,
    runSlug: runSlugSchema,
    epicId: beadIdSchema,
    beadId: beadIdSchema,
    runUpdatedAt: timestampSchema,
    catalogRevision: z.number().int().nonnegative(),
    scopeHash: digestSchema,
  })
  .strict();

export type ProjectCheckpointReviewBinding = z.infer<
  typeof projectCheckpointReviewBindingSchema
>;

export const projectCheckpointReviewScopeSchema = z
  .object({
    projectId: projectIdSchema,
    workspacePath: boundedPathSchema,
    runSlug: runSlugSchema,
    beadId: beadIdSchema,
  })
  .strict();

export type ProjectCheckpointReviewScope = z.infer<
  typeof projectCheckpointReviewScopeSchema
>;

export const projectCheckpointReviewPrepareRequestSchema = z
  .object({
    requestId: requestIdSchema,
    expectedEpicId: beadIdSchema,
    expectedRunUpdatedAt: timestampSchema,
    decision: decisionSchema,
    note: normalizedNoteSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.decision === "request-changes" && value.note.length === 0)
      context.addIssue({
        code: "custom",
        path: ["note"],
        message: "Requesting changes needs a note saying what to change",
      });
  });

export type ProjectCheckpointReviewPrepareRequest = z.infer<
  typeof projectCheckpointReviewPrepareRequestSchema
>;

export const projectCheckpointReviewHashRequestSchema = z
  .object({ intentHash: digestSchema })
  .strict();

export type ProjectCheckpointReviewHashRequest = z.infer<
  typeof projectCheckpointReviewHashRequestSchema
>;

export const projectCheckpointReviewStoredStateSchema = z.enum([
  "prepared",
  "dispatching",
  "confirmed",
  "refused",
  "unknown",
  "retired",
]);

export const projectCheckpointReviewStateSchema = z.enum([
  "prepared",
  "confirmed",
  "refused",
  "unknown",
  "retired",
]);

export type ProjectCheckpointReviewStoredState = z.infer<
  typeof projectCheckpointReviewStoredStateSchema
>;
export type ProjectCheckpointReviewState = z.infer<
  typeof projectCheckpointReviewStateSchema
>;

export const projectCheckpointReviewOriginalPreimageSchema = z
  .object({
    schemaVersion: z.literal(PROJECT_CHECKPOINT_REVIEW_SCHEMA_VERSION),
    requestId: requestIdSchema,
    binding: projectCheckpointReviewBindingSchema,
    decision: decisionSchema,
    note: z.string().max(PROJECT_CHECKPOINT_REVIEW_MAX_NOTE_CHARACTERS),
    commentText: z.string().min(1).max(16_384),
    createdAt: timestampSchema,
  })
  .strict();

export type ProjectCheckpointReviewOriginalPreimage = z.infer<
  typeof projectCheckpointReviewOriginalPreimageSchema
>;

export const projectCheckpointReviewOriginalSchema = z
  .object({
    ...projectCheckpointReviewOriginalPreimageSchema.shape,
    intentHash: digestSchema,
  })
  .strict()
  .superRefine((original, context) => {
    if (
      original.note !== original.note.trim() ||
      original.note.includes(String.fromCharCode(0)) ||
      (original.decision === "request-changes" && original.note.length === 0)
    )
      context.addIssue({
        code: "custom",
        path: ["note"],
        message: "The saved note is not normalized for its decision",
      });
    try {
      if (original.commentText !== projectCheckpointReviewCommentText(original))
        context.addIssue({
          code: "custom",
          path: ["commentText"],
          message: "The saved comment does not match the canonical review text",
        });
    } catch {
      context.addIssue({
        code: "custom",
        path: ["commentText"],
        message: "The saved comment could not be verified",
      });
    }
    if (
      new TextEncoder().encode(JSON.stringify(original)).byteLength >
      PROJECT_CHECKPOINT_REVIEW_MAX_ORIGINAL_BYTES
    )
      context.addIssue({
        code: "custom",
        message: "The checkpoint review original exceeds its byte limit",
      });
  });

export type ProjectCheckpointReviewOriginal = z.infer<
  typeof projectCheckpointReviewOriginalSchema
>;

export function projectCheckpointReviewCommentText(
  original: Pick<
    ProjectCheckpointReviewOriginal,
    "requestId" | "binding" | "decision" | "note"
  >,
): string {
  const review = reviewCommentFor({
    issueId: original.binding.beadId,
    decision: original.decision,
    note: original.note,
  });
  if (!review.ok)
    throw new TypeError("Checkpoint review comment inputs are invalid.");
  return `${review.body}\nForge checkpoint review ${original.requestId}`;
}

export function projectCheckpointReviewOriginalPreimage(
  original: ProjectCheckpointReviewOriginal,
): ProjectCheckpointReviewOriginalPreimage {
  return {
    schemaVersion: PROJECT_CHECKPOINT_REVIEW_SCHEMA_VERSION,
    requestId: original.requestId,
    binding: original.binding,
    decision: original.decision,
    note: original.note,
    commentText: original.commentText,
    createdAt: original.createdAt,
  };
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isJsonObject(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  const encoded = JSON.stringify(value);
  if (encoded === undefined)
    throw new TypeError("Checkpoint review preimage is not JSON data.");
  return encoded;
}

export function projectCheckpointReviewIntentJson(
  original: ProjectCheckpointReviewOriginal,
): string {
  return canonicalJson(projectCheckpointReviewOriginalPreimage(original));
}

export const projectCheckpointReviewMetadataSchema = z
  .object({
    schemaVersion: z.literal(PROJECT_CHECKPOINT_REVIEW_SCHEMA_VERSION),
    requestId: requestIdSchema,
    intentHash: digestSchema,
    scope: projectCheckpointReviewScopeSchema,
    state: projectCheckpointReviewStateSchema,
    commentId: commentIdSchema.nullable(),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .strict();

export type ProjectCheckpointReviewMetadata = z.infer<
  typeof projectCheckpointReviewMetadataSchema
>;

export const projectCheckpointReviewReceiptSchema = z
  .object({
    schemaVersion: z.literal(PROJECT_CHECKPOINT_REVIEW_SCHEMA_VERSION),
    requestId: requestIdSchema,
    intentHash: digestSchema,
    state: projectCheckpointReviewStateSchema,
    commentId: commentIdSchema.nullable(),
    reportedCommentId: commentIdSchema.nullable(),
    readback: z.enum([
      "not-checked",
      "found",
      "absent",
      "incomplete",
      "mismatch",
    ]),
    auditEventId: z.number().int().positive(),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .strict()
  .superRefine((receipt, context) => {
    if (
      receipt.state === "confirmed" &&
      (receipt.commentId === null ||
        receipt.readback !== "found" ||
        (receipt.reportedCommentId !== null &&
          receipt.reportedCommentId !== receipt.commentId))
    )
      context.addIssue({
        code: "custom",
        message:
          "A confirmed checkpoint review needs exact comment readback and identity",
      });
    if (
      (receipt.readback === "found" &&
        (receipt.state !== "confirmed" || receipt.commentId === null)) ||
      (["absent", "incomplete", "mismatch"].includes(receipt.readback) &&
        receipt.state !== "unknown")
    )
      context.addIssue({
        code: "custom",
        message: "Checkpoint review readback and receipt state disagree",
      });
    if (receipt.state === "unknown" && receipt.commentId !== null)
      context.addIssue({
        code: "custom",
        message: "An unverified comment id cannot be presented as confirmed",
      });
    if (
      receipt.state !== "confirmed" &&
      receipt.state !== "unknown" &&
      (receipt.commentId !== null ||
        receipt.reportedCommentId !== null ||
        receipt.readback !== "not-checked")
    )
      context.addIssue({
        code: "custom",
        message:
          "Only an unknown or confirmed review can carry readback evidence",
      });
  });

export type ProjectCheckpointReviewReceipt = z.infer<
  typeof projectCheckpointReviewReceiptSchema
>;

export const projectCheckpointReviewMetadataReadSchema = z
  .object({
    schemaVersion: z.literal(PROJECT_CHECKPOINT_REVIEW_SCHEMA_VERSION),
    scope: projectCheckpointReviewScopeSchema,
    activeRequestId: requestIdSchema.nullable(),
    blocked: z.boolean(),
    items: z
      .array(projectCheckpointReviewMetadataSchema)
      .max(PROJECT_CHECKPOINT_REVIEW_MAX_JOURNAL_RECORDS),
  })
  .strict()
  .superRefine((read, context) => {
    if (
      read.items.some(
        (item) => canonicalJson(item.scope) !== canonicalJson(read.scope),
      )
    )
      context.addIssue({
        code: "custom",
        path: ["items"],
        message: "Checkpoint review history does not match its routing scope",
      });
    if (
      read.activeRequestId !== null &&
      !read.items.some((item) => item.requestId === read.activeRequestId)
    )
      context.addIssue({
        code: "custom",
        path: ["activeRequestId"],
        message: "The active checkpoint review is missing from history",
      });
  });

export type ProjectCheckpointReviewMetadataRead = z.infer<
  typeof projectCheckpointReviewMetadataReadSchema
>;

export const projectCheckpointReviewOriginalReadSchema = z
  .object({
    metadata: projectCheckpointReviewMetadataSchema,
    original: projectCheckpointReviewOriginalSchema,
    receipt: projectCheckpointReviewReceiptSchema,
  })
  .strict()
  .superRefine(({ metadata, original, receipt }, context) => {
    if (
      metadata.requestId !== original.requestId ||
      metadata.requestId !== receipt.requestId ||
      metadata.intentHash !== original.intentHash ||
      metadata.intentHash !== receipt.intentHash ||
      metadata.state !== receipt.state ||
      metadata.commentId !== receipt.commentId ||
      metadata.scope.projectId !== original.binding.projectId ||
      metadata.scope.workspacePath !== original.binding.workspacePath ||
      metadata.scope.runSlug !== original.binding.runSlug ||
      metadata.scope.beadId !== original.binding.beadId ||
      metadata.createdAt !== original.createdAt ||
      metadata.createdAt !== receipt.createdAt ||
      metadata.updatedAt !== receipt.updatedAt
    )
      context.addIssue({
        code: "custom",
        message:
          "The saved checkpoint review metadata does not match its original and receipt",
      });
  });

export type ProjectCheckpointReviewOriginalRead = z.infer<
  typeof projectCheckpointReviewOriginalReadSchema
>;
