import { z } from "zod";
import type {
  CodexChatOwnedMetadata,
  CodexChatOwnedRecord,
} from "../../types/codex-owned-chat";
import type {
  CodexOwnedSessionMetadata,
  CodexOwnedSessionRecord,
} from "../../types/codex-owned-task";
import {
  ownedSessionIdSchema,
  ownedSessionMetadataSchema,
  sessionProjectIdSchema,
  sessionRequestHashSchema,
  sessionRequestIdSchema,
} from "./protocol";

/** Additive registry branch. The original Claude metadata schema stays exact. */
export const codexOwnedMetadataSchema = ownedSessionMetadataSchema
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

export const codexOwnedSessionSchema = codexOwnedMetadataSchema
  .extend({
    projectId: sessionProjectIdSchema,
    id: ownedSessionIdSchema,
    requestId: sessionRequestIdSchema,
    requestHash: sessionRequestHashSchema,
    createdAt: z.iso.datetime(),
  })
  .strict() satisfies z.ZodType<CodexOwnedSessionRecord>;
export const codexChatOwnedMetadataSchema = codexOwnedMetadataSchema
  .extend({ mode: z.literal("chat") })
  .strict() satisfies z.ZodType<CodexChatOwnedMetadata>;
export const codexChatOwnedSessionSchema = codexOwnedSessionSchema
  .extend({ mode: z.literal("chat") })
  .strict() satisfies z.ZodType<CodexChatOwnedRecord>;
