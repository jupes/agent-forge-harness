import { z } from "zod";
import {
  usageThresholdDocumentSchema,
  usageThresholdJson,
  usageThresholdOriginalSchema,
  usageThresholdReceiptSchema,
} from "./usage-threshold-settings";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const instant = z.iso.datetime().refine((value) => value.length === 24);
export const usageThresholdPendingSchema = z
  .object({
    original: usageThresholdOriginalSchema,
    originalHash: hash,
    reservedAt: instant,
  })
  .strict();
export const usageThresholdIntentSchema = z
  .object({
    origin: z.enum(["reservation", "legacy-receipt"]),
    phase: z.enum(["reserved", "discarded", "applied", "refused"]),
    original: usageThresholdOriginalSchema,
    originalHash: hash,
    reservedAt: instant.nullable(),
    discardedAt: instant.nullable(),
    receipt: usageThresholdReceiptSchema.nullable(),
    document: usageThresholdDocumentSchema,
  })
  .strict()
  .refine((row) => {
    if (
      row.document.projectId !== row.original.projectId ||
      row.document.workspace !== row.original.workspace
    )
      return false;
    if (row.origin === "legacy-receipt" && row.reservedAt !== null)
      return false;
    if (row.origin === "reservation" && row.reservedAt === null) return false;
    if (row.phase === "reserved" || row.phase === "discarded")
      return (
        row.origin === "reservation" &&
        row.receipt === null &&
        (row.phase === "reserved"
          ? row.discardedAt === null
          : row.discardedAt !== null && row.discardedAt >= row.reservedAt!)
      );
    const receipt = row.receipt;
    return (
      receipt !== null &&
      row.discardedAt === null &&
      receipt.outcome === row.phase &&
      receipt.originalHash === row.originalHash &&
      usageThresholdJson(receipt.original) ===
        usageThresholdJson(row.original) &&
      row.document.revision >= receipt.resultingRevision &&
      (row.reservedAt === null || receipt.settledAt >= row.reservedAt) &&
      (row.phase !== "applied" ||
        row.document.revision !== receipt.resultingRevision ||
        usageThresholdJson(row.document.rules) ===
          usageThresholdJson(row.original.rules))
    );
  });
export type UsageThresholdIntent = z.infer<typeof usageThresholdIntentSchema>;
export const usageThresholdRecoverySchema = z
  .object({
    version: z.literal(1),
    complete: z.literal(true),
    pending: z.array(usageThresholdPendingSchema).max(256),
  })
  .strict()
  .refine(
    (value) =>
      new Set(value.pending.map((row) => row.original.requestId)).size ===
      value.pending.length,
  );
export type UsageThresholdRecovery = z.infer<
  typeof usageThresholdRecoverySchema
>;
