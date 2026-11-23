import { z } from "zod";
import { workspaceKey } from "../scripts/projects/scope";
import {
  type InboxUsageRulesDocument,
  inboxUsageRulesDocumentSchema,
} from "./inbox-usage";

export const MAX_USAGE_POLICY_REQUEST_BYTES = 256 * 1024;
const counter = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const uuid = z.uuid().refine((value) => value === value.toLowerCase());
const workspace = inboxUsageRulesDocumentSchema.shape.workspace.refine(
  (value) => value === workspaceKey(value),
);
export const usageThresholdRequestSchema = z
  .object({
    requestId: uuid,
    workspace,
    expectedCatalogRevision: counter,
    expectedRevision: counter.max(Number.MAX_SAFE_INTEGER - 1),
    rules: inboxUsageRulesDocumentSchema.shape.rules,
  })
  .strict();
const originalSchema = usageThresholdRequestSchema
  .extend({ projectId: inboxUsageRulesDocumentSchema.shape.projectId })
  .strict();
export type UsageThresholdRequest = z.infer<typeof usageThresholdRequestSchema>;
export type UsageThresholdOriginal = z.infer<typeof originalSchema>;
const receiptSchema = z
  .object({
    original: originalSchema,
    originalHash: z.string().regex(/^[a-f0-9]{64}$/),
    outcome: z.enum(["applied", "refused"]),
    observedRevision: counter,
    resultingRevision: counter,
    settledAt: z.iso.datetime(),
    refusalCode: z.literal("policy-revision-conflict").nullable(),
  })
  .strict()
  .refine((row) =>
    row.outcome === "applied"
      ? row.observedRevision === row.original.expectedRevision &&
        row.resultingRevision === row.original.expectedRevision + 1 &&
        row.refusalCode === null
      : row.observedRevision !== row.original.expectedRevision &&
        row.resultingRevision === row.observedRevision &&
        row.refusalCode === "policy-revision-conflict",
  );
export type UsageThresholdReceipt = z.infer<typeof receiptSchema>;

export interface UsageThresholdRecord {
  receipt: UsageThresholdReceipt;
  document: InboxUsageRulesDocument;
}

const stable = (value: unknown): string => {
  if (Array.isArray(value)) return "[" + value.map(stable).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => JSON.stringify(key) + ":" + stable(item))
        .join(",") +
      "}"
    );
  return JSON.stringify(value) ?? "null";
};

export {
  originalSchema as usageThresholdOriginalSchema,
  receiptSchema as usageThresholdReceiptSchema,
  stable as usageThresholdJson,
};

export const usageThresholdDocumentSchema =
  inboxUsageRulesDocumentSchema.refine(
    (doc) =>
      doc.workspace === workspaceKey(doc.workspace) &&
      (doc.revision > 0 || doc.rules.length === 0),
  );
export const usageThresholdRecordSchema = z
  .object({
    receipt: receiptSchema,
    document: usageThresholdDocumentSchema,
  })
  .strict()
  .refine(
    ({ receipt, document }) =>
      document.projectId === receipt.original.projectId &&
      document.workspace === receipt.original.workspace &&
      document.revision >= receipt.resultingRevision &&
      (receipt.outcome !== "applied" ||
        document.revision !== receipt.resultingRevision ||
        stable(document.rules) === stable(receipt.original.rules)),
  );
