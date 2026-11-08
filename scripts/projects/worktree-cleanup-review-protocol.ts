import { z } from "zod";
import {
  cleanupReceiptSchema,
  cleanupRequestSchema,
} from "./worktree-cleanup-protocol";

const observation = z.object({
  projectId: cleanupReceiptSchema.shape.projectId,
  worktreeId: cleanupRequestSchema.shape.expectedRecord.shape.id,
  asOf: z.iso.datetime(),
  removalAuthorized: z.literal(false),
});
const reasons = z.array(z.string().min(1).max(1000)).min(1).max(20);
const eligible = cleanupRequestSchema
  .omit({ requestId: true })
  .extend({
    ...observation.shape,
    state: z.literal("eligible"),
    reasons: z.tuple([]),
  })
  .strict()
  .refine((review) => review.expectedRecord.id === review.worktreeId);

/** An exact advisory snapshot, never permission to remove or replay cleanup. */
export const cleanupReviewSchema = z.discriminatedUnion("state", [
  eligible,
  observation.extend({ state: z.literal("refused"), reasons }).strict(),
  observation.extend({ state: z.literal("unknown"), reasons }).strict(),
]);
export type CleanupReview = z.infer<typeof cleanupReviewSchema>;
