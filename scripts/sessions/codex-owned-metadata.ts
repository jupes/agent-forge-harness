import { z } from "zod";
import type {
  CodexChatOwnedMetadata,
  CodexChatOwnedRecord,
} from "../../types/codex-owned-chat";
import type {
  CodexOwnedSessionMetadata,
  CodexOwnedSessionRecord,
} from "../../types/codex-owned-task";
import { codexChatForkOriginSchema } from "./codex-chat-fork-origin-protocol";
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

const codexOwnedSessionFieldsSchema = codexOwnedMetadataFieldsSchema
  .extend({
    projectId: sessionProjectIdSchema,
    id: ownedSessionIdSchema,
    requestId: sessionRequestIdSchema,
    requestHash: sessionRequestHashSchema,
    createdAt: z.iso.datetime(),
  })
  .strict() satisfies z.ZodType<CodexOwnedSessionRecord>;

export const codexOwnedSessionSchema = codexOwnedSessionFieldsSchema.refine(
  (value) =>
    validOwnedSessionOrigin(value) &&
    (!value.origin || value.origin.projectId === value.projectId),
);

const codexChatOwnedMetadataFieldsSchema = codexOwnedMetadataFieldsSchema
  .omit({ mode: true, origin: true })
  .extend({
    mode: z.literal("chat"),
    origin: codexChatForkOriginSchema.optional(),
  })
  .strict() satisfies z.ZodType<CodexChatOwnedMetadata>;
export const codexChatOwnedMetadataSchema = codexChatOwnedMetadataFieldsSchema;
const codexChatOwnedSessionFieldsSchema: z.ZodType<CodexChatOwnedRecord> =
  codexChatOwnedMetadataFieldsSchema
    .extend({
      projectId: sessionProjectIdSchema,
      id: ownedSessionIdSchema,
      requestId: sessionRequestIdSchema,
      requestHash: sessionRequestHashSchema,
      createdAt: z.iso.datetime(),
    })
    .strict()
    .refine(
      (value) => !value.origin || value.origin.projectId === value.projectId,
    );
export const codexChatOwnedSessionSchema = codexChatOwnedSessionFieldsSchema;
