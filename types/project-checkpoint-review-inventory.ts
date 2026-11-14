import { z } from "zod";
import { workspaceKey } from "../scripts/projects/scope";
import {
  type ProjectCheckpointReviewOriginalRead,
  projectCheckpointReviewOriginalReadSchema,
  projectCheckpointReviewScopeSchema,
} from "./project-checkpoint-reviews";
export const CHECKPOINT_REVIEW_INVENTORY_MAX_BYTES = 4 * 1024 * 1024;
export const CHECKPOINT_REVIEW_INVENTORY_MAX_RECORDS = 1000;
export const CHECKPOINT_REVIEW_INVENTORY_UNAVAILABLE =
  "Retained checkpoint reviews could not be completely observed. Saved originals remain available for exact recovery.";
export const projectCheckpointReviewInventoryScopeSchema =
  projectCheckpointReviewScopeSchema.pick({
    projectId: true,
    workspacePath: true,
  });
const payload = z
  .object({
    schemaVersion: z.literal(1),
    scope: projectCheckpointReviewInventoryScopeSchema,
    coverage: z.literal("retained-review-records"),
    records: z
      .array(projectCheckpointReviewOriginalReadSchema)
      .max(CHECKPOINT_REVIEW_INVENTORY_MAX_RECORDS),
  })
  .strict();
const available = payload
  .extend({
    available: z.literal(true),
    observationRevision: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      new Set(value.records.map((row) => row.original.requestId)).size !==
        value.records.length ||
      value.records.some(
        (row) =>
          row.original.binding.projectId !== value.scope.projectId ||
          workspaceKey(row.original.binding.workspacePath) !==
            workspaceKey(value.scope.workspacePath),
      )
    )
      context.addIssue({
        code: "custom",
        message:
          "Retained reviews do not match the protected project and workspace",
      });
    if (
      new TextEncoder().encode(
        JSON.stringify({ ok: true, data: value, error: null }),
      ).byteLength > CHECKPOINT_REVIEW_INVENTORY_MAX_BYTES
    )
      context.addIssue({
        code: "custom",
        message:
          "The full retained-review response exceeds its supported byte ceiling",
      });
  });
export const projectCheckpointReviewInventoryReadSchema = z.discriminatedUnion(
  "available",
  [
    available,
    z
      .object({
        available: z.literal(false),
        error: z.literal(CHECKPOINT_REVIEW_INVENTORY_UNAVAILABLE),
      })
      .strict(),
  ],
);
export type ProjectCheckpointReviewInventoryRead = z.infer<
  typeof projectCheckpointReviewInventoryReadSchema
>;
/** Observation digest only; never a stored original preimage or action admission token. */
export function projectCheckpointReviewInventoryJson(
  scope: z.infer<typeof projectCheckpointReviewInventoryScopeSchema>,
  records: readonly ProjectCheckpointReviewOriginalRead[],
): string {
  return JSON.stringify(
    payload.parse({
      schemaVersion: 1,
      scope,
      coverage: "retained-review-records",
      records,
    }),
  );
}
