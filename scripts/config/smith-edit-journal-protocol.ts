/** Private Smith edit journal records; request bytes stay in this owner-only store. */
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  type SmithCreateOwner,
  smithCreateOwnerHash,
  smithCreateOwnerSchema,
} from "./smith-create-journal-protocol";
import {
  canonicalSmithConfigEditRequest,
  SMITH_CONFIG_EDIT_LIMITS,
  smithConfigEditPreviewSchema,
  smithConfigEditReceiptSchema,
  smithConfigEditRefusalSchema,
  smithConfigEditRequestIdSchema,
  smithConfigEditRequestSchema,
} from "./smith-edit-protocol";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const at = z.iso.datetime();

export const smithEditJournalHash = (text: string): string =>
  createHash("sha256").update(text, "utf8").digest("hex");
export const smithEditInputHash = (value: unknown): string =>
  smithEditJournalHash(canonicalSmithConfigEditRequest(value));
export const smithEditOwnerHash = smithCreateOwnerHash;
export const smithEditOwnerSchema = smithCreateOwnerSchema;
export type SmithEditOwner = SmithCreateOwner;

const common = {
  version: z.literal(1),
  requestId: smithConfigEditRequestIdSchema,
  ownerScopeHash: hash,
  inputHash: hash,
  at,
};
export const smithEditIntentSchema = z
  .object({
    ...common,
    kind: z.literal("intent"),
    owner: smithEditOwnerSchema,
    original: smithConfigEditRequestSchema,
  })
  .strict()
  .refine(
    (value) =>
      value.requestId === value.original.requestId &&
      value.inputHash === smithEditInputHash(value.original) &&
      value.ownerScopeHash === smithEditOwnerHash(value.owner),
  );
export type SmithEditIntent = z.infer<typeof smithEditIntentSchema>;

const phase = { ...common, intentHash: hash };
export const smithEditPhaseSchema = z.discriminatedUnion("kind", [
  z
    .object({
      ...phase,
      kind: z.literal("prepared"),
      preview: smithConfigEditPreviewSchema,
    })
    .strict(),
  z
    .object({
      ...phase,
      kind: z.literal("attempted"),
      preparedHash: hash,
    })
    .strict(),
  z
    .object({
      ...phase,
      kind: z.literal("confirmed"),
      preparedHash: hash,
      attemptedHash: hash,
      publication: z
        .object({
          file: z.string().min(1).max(SMITH_CONFIG_EDIT_LIMITS.pathLength),
          created: z.boolean(),
          sha256: hash,
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...phase,
      kind: z.literal("refused"),
      preparedHash: hash.nullable(),
      reason: smithConfigEditRefusalSchema,
    })
    .strict(),
  z
    .object({
      ...phase,
      kind: z.literal("unconfirmed"),
      preparedHash: hash,
      attemptedHash: hash.nullable(),
    })
    .strict(),
]);
export type SmithEditPhase = z.infer<typeof smithEditPhaseSchema>;

export const SMITH_EDIT_JOURNAL_FILES = [
  "intent.json",
  "prepared.json",
  "attempted.json",
  "confirmed.json",
  "refused.json",
  "unconfirmed.json",
] as const;
export type SmithEditJournalFile = (typeof SMITH_EDIT_JOURNAL_FILES)[number];
export const SMITH_EDIT_JOURNAL_LIMITS = Object.freeze({
  operations: SMITH_CONFIG_EDIT_LIMITS.records,
  filesPerOperation: SMITH_EDIT_JOURNAL_FILES.length,
  fileBytes: SMITH_CONFIG_EDIT_LIMITS.privateRecordBytes,
  operationBytes:
    SMITH_EDIT_JOURNAL_FILES.length *
    SMITH_CONFIG_EDIT_LIMITS.privateRecordBytes,
  entries: SMITH_CONFIG_EDIT_LIMITS.records * SMITH_EDIT_JOURNAL_FILES.length,
  bytes:
    SMITH_CONFIG_EDIT_LIMITS.records *
    SMITH_EDIT_JOURNAL_FILES.length *
    SMITH_CONFIG_EDIT_LIMITS.privateRecordBytes,
});

/** Storage bounds before reading; this check precedes JSON parsing. */
export function parseSmithEditJournalText(text: string): unknown {
  if (
    text.length > SMITH_EDIT_JOURNAL_LIMITS.fileBytes ||
    new TextEncoder().encode(text).byteLength >
      SMITH_EDIT_JOURNAL_LIMITS.fileBytes
  )
    throw Error("The private Smith edit record exceeds its byte limit.");
  try {
    return JSON.parse(text);
  } catch {
    throw Error("The private Smith edit record is invalid.");
  }
}
