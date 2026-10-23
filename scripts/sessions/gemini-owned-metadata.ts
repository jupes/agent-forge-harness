import { z } from "zod";
import type {
  GeminiOwnedSessionMetadata,
  GeminiOwnedSessionRecord,
} from "../../types/gemini-owned-task";
import { geminiTaskLaunchSchema } from "./gemini-task";
import {
  ownedSessionIdSchema,
  ownedSessionMetadataSchema,
  sessionProjectIdSchema,
  sessionRequestHashSchema,
  sessionRequestIdSchema,
} from "./protocol";

/** Metadata has no native identity, private report or provider invocation authority. */
export const geminiOwnedMetadataSchema = ownedSessionMetadataSchema
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

export const geminiOwnedSessionSchema = geminiOwnedMetadataSchema
  .extend({
    projectId: sessionProjectIdSchema,
    id: ownedSessionIdSchema,
    requestId: sessionRequestIdSchema,
    requestHash: sessionRequestHashSchema,
    createdAt: z.iso.datetime(),
  })
  .strict() satisfies z.ZodType<GeminiOwnedSessionRecord>;
