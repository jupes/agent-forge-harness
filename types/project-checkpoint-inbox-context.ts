import { z } from "zod";
import {
  PROJECT_CHECKPOINT_REVIEW_MAX_JOURNAL_RECORDS,
  projectCheckpointReviewOriginalReadSchema,
} from "./project-checkpoint-reviews";
import { projectCheckpointSourceContextSchema } from "./project-checkpoint-source-context";
export const CHECKPOINT_INBOX_CONTEXT_MAX_BYTES = 4 * 1024 * 1024;
export const CHECKPOINT_INBOX_CONTEXT_UNAVAILABLE =
  "The checkpoint source and review association is unavailable. Read retained originals before trying again.";
const available = z
  .object({
    available: z.literal(true),
    schemaVersion: z.literal(1),
    context: projectCheckpointSourceContextSchema,
    association: z
      .object({
        complete: z.boolean(),
        blockedElsewhere: z.boolean(),
        records: z
          .array(projectCheckpointReviewOriginalReadSchema)
          .max(PROJECT_CHECKPOINT_REVIEW_MAX_JOURNAL_RECORDS),
      })
      .strict(),
  })
  .strict()
  .superRefine((value, context) => {
    const applicable =
      value.context.state === "current" &&
      value.context.continuity === "anchored" &&
      value.context.reviewBinding !== null;
    const rows = value.association.records;
    const active = rows.filter(
      (row) =>
        row.receipt.state === "prepared" || row.receipt.state === "unknown",
    );
    if (
      value.association.complete !== applicable ||
      (!applicable && rows.length !== 0) ||
      active.length > 1 ||
      (value.association.blockedElsewhere && active.length > 0) ||
      new Set(rows.map((row) => row.original.requestId)).size !== rows.length ||
      rows.some(
        (row) =>
          JSON.stringify(row.original.binding) !==
          JSON.stringify(value.context.reviewBinding),
      )
    )
      context.addIssue({
        code: "custom",
        message:
          "The review association does not match the exact current source",
      });
    if (
      new TextEncoder().encode(
        JSON.stringify({ ok: true, data: value, error: null }),
      ).byteLength > CHECKPOINT_INBOX_CONTEXT_MAX_BYTES
    )
      context.addIssue({
        code: "custom",
        message:
          "The complete checkpoint association exceeds its supported receiving bound",
      });
  });
export const projectCheckpointInboxContextReadSchema = z.discriminatedUnion(
  "available",
  [
    available,
    z
      .object({
        available: z.literal(false),
        error: z.literal(CHECKPOINT_INBOX_CONTEXT_UNAVAILABLE),
      })
      .strict(),
  ],
);
export type ProjectCheckpointInboxContextRead = z.infer<
  typeof projectCheckpointInboxContextReadSchema
>;
