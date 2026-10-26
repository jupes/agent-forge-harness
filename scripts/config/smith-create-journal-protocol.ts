/** Private journal evidence. This module is never imported by the browser. */
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  canonicalSmithConfigCreateRequest,
  SMITH_CONFIG_CREATE_LIMITS,
  smithConfigCreateRefusalSchema,
  smithConfigCreateRequestSchema,
  smithConfigHashSchema,
  smithConfigPreviewSchema,
  smithConfigRequestIdSchema,
} from "./smith-create-protocol";

const path = z
  .string()
  .min(1)
  .max(SMITH_CONFIG_CREATE_LIMITS.pathLength)
  .refine(
    (value) =>
      value.startsWith("/") ||
      value.startsWith("\\\\") ||
      /^[a-zA-Z]:[\\/]/.test(value),
  );
export const smithCreateOwnerSchema = z
  .object({
    version: z.literal(1),
    checkout: z
      .object({
        path,
        dev: z.string().regex(/^\d{1,64}$/),
        ino: z.string().regex(/^\d{1,64}$/),
      })
      .strict(),
    profile: path,
    userSelector: path,
    workspaceSelector: path,
  })
  .strict();
export type SmithCreateOwner = z.infer<typeof smithCreateOwnerSchema>;

export const smithCreateJournalHash = (text: string): string =>
  createHash("sha256").update(text, "utf8").digest("hex");
export const smithCreateInputHash = (value: unknown): string =>
  smithCreateJournalHash(canonicalSmithConfigCreateRequest(value));
export function smithCreateOwnerHash(value: unknown): string {
  const owner = smithCreateOwnerSchema.parse(value);
  return smithCreateJournalHash(JSON.stringify(owner));
}

const common = {
  version: z.literal(1),
  requestId: smithConfigRequestIdSchema,
  ownerScopeHash: smithConfigHashSchema,
  inputHash: smithConfigHashSchema,
  at: z.iso.datetime(),
};
export const smithCreateIntentSchema = z
  .object({
    ...common,
    kind: z.literal("intent"),
    owner: smithCreateOwnerSchema,
    original: smithConfigCreateRequestSchema,
  })
  .strict()
  .refine(
    (value) =>
      value.requestId === value.original.requestId &&
      value.inputHash === smithCreateInputHash(value.original) &&
      value.ownerScopeHash === smithCreateOwnerHash(value.owner),
  );
export type SmithCreateIntent = z.infer<typeof smithCreateIntentSchema>;

const phase = { ...common, intentHash: smithConfigHashSchema };
export const smithCreatePhaseSchema = z.discriminatedUnion("kind", [
  z
    .object({
      ...phase,
      kind: z.literal("prepared"),
      preview: smithConfigPreviewSchema,
    })
    .strict(),
  z
    .object({
      ...phase,
      kind: z.literal("attempted"),
      preparedHash: smithConfigHashSchema,
    })
    .strict(),
  z
    .object({
      ...phase,
      kind: z.literal("confirmed"),
      preparedHash: smithConfigHashSchema,
      attemptedHash: smithConfigHashSchema,
      publication: z
        .object({
          file: path,
          created: z.boolean(),
          sha256: smithConfigHashSchema,
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...phase,
      kind: z.literal("refused"),
      preparedHash: smithConfigHashSchema.nullable(),
      reason: smithConfigCreateRefusalSchema,
    })
    .strict(),
  z
    .object({
      ...phase,
      kind: z.literal("unconfirmed"),
      preparedHash: smithConfigHashSchema,
      attemptedHash: smithConfigHashSchema.nullable(),
    })
    .strict(),
]);
export type SmithCreatePhase = z.infer<typeof smithCreatePhaseSchema>;

export const SMITH_CREATE_JOURNAL_FILES = [
  "intent.json",
  "prepared.json",
  "attempted.json",
  "confirmed.json",
  "refused.json",
  "unconfirmed.json",
] as const;
export type SmithCreateJournalFile =
  (typeof SMITH_CREATE_JOURNAL_FILES)[number];
export const SMITH_CREATE_JOURNAL_LIMITS = Object.freeze({
  operations: SMITH_CONFIG_CREATE_LIMITS.records,
  filesPerOperation: SMITH_CREATE_JOURNAL_FILES.length,
  fileBytes: SMITH_CONFIG_CREATE_LIMITS.privateRecordBytes,
  operationBytes:
    SMITH_CREATE_JOURNAL_FILES.length *
    SMITH_CONFIG_CREATE_LIMITS.privateRecordBytes,
  entries:
    SMITH_CONFIG_CREATE_LIMITS.records * SMITH_CREATE_JOURNAL_FILES.length,
  bytes:
    SMITH_CONFIG_CREATE_LIMITS.records *
    SMITH_CREATE_JOURNAL_FILES.length *
    SMITH_CONFIG_CREATE_LIMITS.privateRecordBytes,
});

/** Storage must bound before reading; this second check precedes JSON parsing. */
export function parseSmithCreateJournalText(text: string): unknown {
  if (
    text.length > SMITH_CREATE_JOURNAL_LIMITS.fileBytes ||
    new TextEncoder().encode(text).byteLength >
      SMITH_CREATE_JOURNAL_LIMITS.fileBytes
  )
    throw Error("The private Smith create record exceeds its byte limit.");
  try {
    return JSON.parse(text);
  } catch {
    throw Error("The private Smith create record is invalid.");
  }
}
