import { z } from "zod";
import type {
  CodexOwnedSessionMetadata,
  CodexOwnedSessionRecord,
} from "../../types/codex-owned-task";
import {
  ownedSessionIdSchema,
  ownedSessionMetadataFieldsSchema,
  sessionProjectIdSchema,
  sessionRequestHashSchema,
  sessionRequestIdSchema,
  validOwnedSessionOrigin,
} from "./protocol";

/** Additive registry branch. The original Claude metadata schema stays exact. */
const codexOwnedMetadataFieldsSchema = ownedSessionMetadataFieldsSchema
  .omit({ provider: true, mode: true, requestedEffort: true })
  .extend({
    provider: z.literal("codex"),
    mode: z.literal("task"),
    requestedEffort: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/)
      .nullable(),
  })
  .strict() satisfies z.ZodType<CodexOwnedSessionMetadata>;
export const codexOwnedMetadataSchema = codexOwnedMetadataFieldsSchema.refine(
  validOwnedSessionOrigin,
);

export const codexOwnedSessionSchema = codexOwnedMetadataFieldsSchema
  .extend({
    projectId: sessionProjectIdSchema,
    id: ownedSessionIdSchema,
    requestId: sessionRequestIdSchema,
    requestHash: sessionRequestHashSchema,
    createdAt: z.iso.datetime(),
  })
  .strict()
  .refine(
    (value) =>
      validOwnedSessionOrigin(value) &&
      (!value.origin || value.origin.projectId === value.projectId),
  ) satisfies z.ZodType<CodexOwnedSessionRecord>;
