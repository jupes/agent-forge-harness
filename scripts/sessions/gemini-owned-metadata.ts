import { z } from "zod";
import type {
  GeminiOwnedSessionMetadata,
  GeminiOwnedSessionRecord,
} from "../../types/gemini-owned-task";
import { geminiTaskLaunchSchema } from "./gemini-task";
import {
  ownedSessionIdSchema,
  ownedSessionMetadataFieldsSchema,
  sessionProjectIdSchema,
  sessionRequestHashSchema,
  sessionRequestIdSchema,
  validOwnedSessionOrigin,
} from "./protocol";

/** Metadata has no native identity, private report or provider invocation authority. */
const geminiOwnedMetadataFieldsSchema = ownedSessionMetadataFieldsSchema
  .omit({
    provider: true,
    mode: true,
    requestedModel: true,
    requestedEffort: true,
  })
  .extend({
    provider: z.literal("gemini"),
    route: z.literal("gemini-cli"),
    mode: z.literal("task"),
    requestedModel: geminiTaskLaunchSchema.shape.model.unwrap().nullable(),
    requestedEffort: z.null(),
  })
  .strict() satisfies z.ZodType<GeminiOwnedSessionMetadata>;
export const geminiOwnedMetadataSchema = geminiOwnedMetadataFieldsSchema.refine(
  validOwnedSessionOrigin,
);

export const geminiOwnedSessionSchema = geminiOwnedMetadataFieldsSchema
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
  ) satisfies z.ZodType<GeminiOwnedSessionRecord>;
