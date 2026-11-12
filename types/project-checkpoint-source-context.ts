import { z } from "zod";
import {
  projectCheckpointReviewBindingSchema,
  projectCheckpointReviewScopeSchema,
} from "./project-checkpoint-reviews";
import {
  CHECKPOINT_SUBMISSION_MAX_RECORDS,
  projectCheckpointSourceVersionSchema,
  projectCheckpointSubmissionRecordSchema,
  projectCheckpointSubmissionScope,
} from "./project-checkpoint-submissions";

const generation = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const requestId = z.uuid().refine((value) => value === value.toLowerCase());
const location = projectCheckpointReviewScopeSchema.omit({
  workspacePath: true,
});
export const CHECKPOINT_SOURCE_UNAVAILABLE =
  "The checkpoint source context is unavailable. Read saved source records before trying again.";
export const projectCheckpointSourceContextSchema = z
  .object({
    state: z.enum(["unbound", "withdrawn", "foreign", "current", "stale"]),
    generation,
    continuity: z.enum(["anchored", "legacy-unverified"]),
    baseBinding: projectCheckpointReviewBindingSchema,
    sourceVersion: projectCheckpointSourceVersionSchema,
    reviewBinding: projectCheckpointReviewBindingSchema.nullable(),
    record: projectCheckpointSubmissionRecordSchema.nullable(),
    foreign: location.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    const same = (a: unknown, b: unknown) =>
      JSON.stringify(a) === JSON.stringify(b);
    const { projectId, workspacePath, runSlug, beadId } = value.baseBinding;
    const scope = { projectId, workspacePath, runSlug, beadId };
    const current = value.state === "current";
    if (
      (value.reviewBinding !== null) !== current ||
      (value.foreign !== null) !== (value.state === "foreign") ||
      (value.record !== null) !== (current || value.state === "stale") ||
      (value.continuity === "legacy-unverified" &&
        (value.state !== "unbound" || value.generation !== 0))
    )
      context.addIssue({
        code: "custom",
        message: "The checked source state is inconsistent",
      });
    if (
      value.record &&
      (value.record.original.kind !== "publish" ||
        !same(projectCheckpointSubmissionScope(value.record.original), scope) ||
        value.record.receipt.resultingGeneration !== value.generation)
    )
      context.addIssue({
        code: "custom",
        message: "The current source record has another scope or generation",
      });
    if (
      current &&
      value.record?.original.kind === "publish" &&
      (!same(value.record.original.binding, value.baseBinding) ||
        !same(value.record.original.sourceVersion, value.sourceVersion) ||
        !same(value.reviewBinding, {
          ...value.baseBinding,
          scopeHash: value.record.receipt.reviewScopeHash,
        }))
    )
      context.addIssue({
        code: "custom",
        message: "The Review binding does not name the checked source",
      });
  });
export type ProjectCheckpointSourceContext = z.infer<
  typeof projectCheckpointSourceContextSchema
>;
export const projectCheckpointSourceContextReadSchema = z.discriminatedUnion(
  "available",
  [
    z
      .object({
        available: z.literal(true),
        context: projectCheckpointSourceContextSchema,
      })
      .strict(),
    z
      .object({
        available: z.literal(false),
        error: z.literal(CHECKPOINT_SOURCE_UNAVAILABLE),
      })
      .strict(),
  ],
);
export type ProjectCheckpointSourceContextRead = z.infer<
  typeof projectCheckpointSourceContextReadSchema
>;
export const projectCheckpointSourceInventorySchema = z
  .object({
    generation,
    everBound: z.boolean(),
    legacySource: z.enum(["verified-v1", "missing-context"]).nullable(),
    blocked: z.boolean(),
    currentRequestId: requestId.nullable(),
    items: z
      .array(projectCheckpointSubmissionRecordSchema)
      .max(CHECKPOINT_SUBMISSION_MAX_RECORDS),
  })
  .strict();
export type ProjectCheckpointSourceInventory = z.infer<
  typeof projectCheckpointSourceInventorySchema
>;
