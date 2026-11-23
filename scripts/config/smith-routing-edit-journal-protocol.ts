/** Private durable evidence for Smith routing edits; never imported by browser code. */
import { createHash } from "node:crypto";
import { z } from "zod";
import type {
  SmithRoutingEditPreview,
  SmithRoutingEditReceipt,
  SmithRoutingEditRequest,
} from "../../types/smith-routing-edit";
import {
  smithCreateOwnerHash,
  smithCreateOwnerSchema,
} from "./smith-create-journal-protocol";
import {
  canonicalSmithRoutingEditRequest,
  SMITH_ROUTING_EDIT_LIMITS,
  smithRoutingEditPreviewSchema,
  smithRoutingEditRefusalSchema,
  smithRoutingEditRequestIdSchema,
  smithRoutingEditRequestSchema,
  smithRoutingEditSuccessEnvelopeWithin,
} from "./smith-routing-edit-protocol";

export { smithRoutingEditReceiptSchema } from "./smith-routing-edit-protocol";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const timestamp = z.iso.datetime();
const filePath = z
  .string()
  .min(1)
  .max(SMITH_ROUTING_EDIT_LIMITS.pathLength)
  .refine(
    (value) =>
      value.startsWith("/") ||
      value.startsWith("\\\\") ||
      /^[a-zA-Z]:[\\/]/.test(value),
  );

export const smithRoutingEditJournalHash = (text: string): string =>
  createHash("sha256").update(text, "utf8").digest("hex");
export const smithRoutingEditInputHash = (value: unknown): string =>
  smithRoutingEditJournalHash(canonicalSmithRoutingEditRequest(value));
export const smithRoutingEditOwnerHash = (
  owner: SmithRoutingEditJournalOwner,
) => smithCreateOwnerHash(owner);
export const smithRoutingEditJournalOwnerSchema = smithCreateOwnerSchema;
export type SmithRoutingEditJournalOwner = z.infer<
  typeof smithCreateOwnerSchema
>;

const intentBase = {
  version: z.literal(1),
  kind: z.literal("intent"),
  requestId: smithRoutingEditRequestIdSchema,
  ownerScopeHash: hash,
  inputHash: hash,
  owner: smithRoutingEditJournalOwnerSchema,
  original: smithRoutingEditRequestSchema,
  at: timestamp,
};
export const smithRoutingEditJournalIntentSchema = z
  .object(intentBase)
  .strict()
  .refine(
    (value) =>
      value.requestId === value.original.requestId &&
      value.inputHash === smithRoutingEditInputHash(value.original) &&
      value.ownerScopeHash === smithRoutingEditOwnerHash(value.owner),
  );
export type SmithRoutingEditJournalIntent = z.infer<
  typeof smithRoutingEditJournalIntentSchema
>;

const phaseBase = {
  version: z.literal(1),
  requestId: smithRoutingEditRequestIdSchema,
  ownerScopeHash: hash,
  inputHash: hash,
  intentHash: hash,
  at: timestamp,
};
const publication = z
  .object({ file: filePath, created: z.boolean(), sha256: hash })
  .strict();
export const smithRoutingEditJournalPhaseSchema = z.discriminatedUnion("kind", [
  z
    .object({
      ...phaseBase,
      kind: z.literal("prepared"),
      preview: smithRoutingEditPreviewSchema,
    })
    .strict(),
  z
    .object({
      ...phaseBase,
      kind: z.literal("attempted"),
      preparedHash: hash,
    })
    .strict(),
  z
    .object({
      ...phaseBase,
      kind: z.literal("confirmed"),
      preparedHash: hash,
      attemptedHash: hash,
      publication,
    })
    .strict(),
  z
    .object({
      ...phaseBase,
      kind: z.literal("refused"),
      reason: smithRoutingEditRefusalSchema,
    })
    .strict(),
  z
    .object({
      ...phaseBase,
      kind: z.literal("unconfirmed"),
      preparedHash: hash,
      attemptedHash: hash,
    })
    .strict(),
]);
export type SmithRoutingEditJournalPhase = z.infer<
  typeof smithRoutingEditJournalPhaseSchema
>;

export const SMITH_ROUTING_EDIT_JOURNAL_FILES = [
  "intent.json",
  "prepared.json",
  "attempted.json",
  "confirmed.json",
  "refused.json",
  "unconfirmed.json",
] as const;
export type SmithRoutingEditJournalFile =
  (typeof SMITH_ROUTING_EDIT_JOURNAL_FILES)[number];
export const SMITH_ROUTING_EDIT_JOURNAL_BOUNDS = Object.freeze({
  operations: SMITH_ROUTING_EDIT_LIMITS.records,
  filesPerOperation: SMITH_ROUTING_EDIT_JOURNAL_FILES.length,
  fileBytes: SMITH_ROUTING_EDIT_LIMITS.privateRecordBytes,
  operationBytes:
    SMITH_ROUTING_EDIT_JOURNAL_FILES.length *
    SMITH_ROUTING_EDIT_LIMITS.privateRecordBytes,
  entries:
    SMITH_ROUTING_EDIT_LIMITS.records * SMITH_ROUTING_EDIT_JOURNAL_FILES.length,
  bytes:
    SMITH_ROUTING_EDIT_LIMITS.records *
    SMITH_ROUTING_EDIT_JOURNAL_FILES.length *
    SMITH_ROUTING_EDIT_LIMITS.privateRecordBytes,
});

export function parseSmithRoutingEditJournalRecord(text: string): unknown {
  if (
    text.length > SMITH_ROUTING_EDIT_JOURNAL_BOUNDS.fileBytes ||
    new TextEncoder().encode(text).byteLength >
      SMITH_ROUTING_EDIT_JOURNAL_BOUNDS.fileBytes
  )
    throw new Error("The private routing edit record exceeds its byte limit.");
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("The private routing edit record is invalid.");
  }
}

export type SmithRoutingEditIntentInput = Readonly<SmithRoutingEditRequest>;
export type SmithRoutingEditIntentReceipt = SmithRoutingEditReceipt;
export type SmithRoutingEditIntentPreview = SmithRoutingEditPreview;
