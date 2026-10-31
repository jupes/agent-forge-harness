import { z } from "zod";

export const INBOX_SOURCE_KINDS = [
  "bead-approval",
  "checkpoint-review",
  "permission",
  "failed-gate",
  "halted-bead",
  "stopped-shift",
  "council-verdict",
  "unknown-bead-write",
  "usage-threshold",
] as const;
const boundedText = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((value) =>
      [...value].every(
        (character) =>
          character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127,
      ),
    );

export const inboxDispositionOriginalSchema = z
  .object({
    requestId: z
      .string()
      .uuid()
      .refine((value) => value === value.toLowerCase()),
    expectedCatalogRevision: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER),
    workspace: boundedText(1024),
    item: z
      .object({
        sourceKind: z.enum(INBOX_SOURCE_KINDS),
        stableItemId: boundedText(200),
        sourceRevision: boundedText(200),
      })
      .strict(),
    expectedRevision: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER - 1),
    operation: z.enum(["done", "snooze-1h"]),
  })
  .strict();

export const inboxDispositionStoredOriginalSchema =
  inboxDispositionOriginalSchema
    .extend({
      projectId: z
        .string()
        .regex(
          /^project-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
        ),
    })
    .strict();

export const inboxDispositionReceiptSchema = z
  .object({
    original: inboxDispositionStoredOriginalSchema,
    phase: z.enum(["reserved", "applied", "refused"]),
    reservedAt: z.iso.datetime(),
    settledAt: z.iso.datetime().optional(),
    outcome: z.enum(["applied", "refused"]).optional(),
    resultingRevision: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER)
      .optional(),
    resultingValue: z.enum(["done", "snooze-1h"]).optional(),
    snoozedUntil: z.iso.datetime().optional(),
    refusalCode: z.string().min(1).max(64).optional(),
    refusalReason: z.string().min(1).max(300).optional(),
  })
  .strict()
  .superRefine((receipt, context) => {
    if (receipt.phase === "reserved") {
      if (
        receipt.settledAt !== undefined ||
        receipt.outcome !== undefined ||
        receipt.resultingRevision !== undefined ||
        receipt.resultingValue !== undefined ||
        receipt.snoozedUntil !== undefined ||
        receipt.refusalCode !== undefined ||
        receipt.refusalReason !== undefined
      )
        context.addIssue({
          code: "custom",
          message: "reserved receipt has no outcome",
        });
    } else if (receipt.phase === "applied") {
      const settled = Date.parse(receipt.settledAt ?? "");
      if (
        receipt.settledAt === undefined ||
        receipt.outcome !== "applied" ||
        receipt.resultingRevision === undefined ||
        receipt.resultingRevision !== receipt.original.expectedRevision + 1 ||
        receipt.resultingValue !== receipt.original.operation ||
        (receipt.original.operation === "snooze-1h") !==
          (receipt.snoozedUntil !== undefined) ||
        settled < Date.parse(receipt.reservedAt) ||
        (receipt.snoozedUntil !== undefined &&
          Date.parse(receipt.snoozedUntil) !== settled + 60 * 60 * 1000) ||
        receipt.refusalCode !== undefined ||
        receipt.refusalReason !== undefined
      )
        context.addIssue({
          code: "custom",
          message: "applied receipt is incomplete",
        });
    } else if (
      receipt.settledAt === undefined ||
      receipt.outcome !== "refused" ||
      receipt.refusalCode === undefined ||
      receipt.refusalReason === undefined ||
      receipt.resultingRevision !== undefined ||
      receipt.resultingValue !== undefined ||
      receipt.snoozedUntil !== undefined ||
      Date.parse(receipt.settledAt ?? "") < Date.parse(receipt.reservedAt)
    ) {
      context.addIssue({
        code: "custom",
        message: "refused receipt is incomplete",
      });
    }
  });

export const inboxDispositionEntrySchema = z
  .object({
    projectId: z
      .string()
      .regex(
        /^project-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      ),
    workspace: boundedText(1024),
    item: z
      .object({
        sourceKind: z.enum(INBOX_SOURCE_KINDS),
        stableItemId: boundedText(200),
        sourceRevision: boundedText(200),
      })
      .strict(),
    revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    operation: z.enum(["done", "snooze-1h"]),
    updatedAt: z.iso.datetime(),
    snoozedUntil: z.iso.datetime().optional(),
  })
  .strict()
  .refine(
    (entry) =>
      (entry.operation === "snooze-1h") === (entry.snoozedUntil !== undefined),
  );

export const inboxDispositionStoreSchema = z
  .object({
    version: z.literal(1),
    entries: z.array(inboxDispositionEntrySchema).max(1000),
    receipts: z.array(inboxDispositionReceiptSchema).max(4096),
  })
  .strict()
  .superRefine((store, context) => {
    const entryIds = store.entries.map((entry) =>
      JSON.stringify([
        entry.projectId,
        entry.workspace,
        entry.item.sourceKind,
        entry.item.stableItemId,
        entry.item.sourceRevision,
      ]),
    );
    const requestIds = store.receipts.map(
      (receipt) => receipt.original.requestId,
    );
    const pendingFences = store.receipts
      .filter((receipt) => receipt.phase === "reserved")
      .map((receipt) =>
        JSON.stringify([
          receipt.original.projectId,
          receipt.original.workspace,
          receipt.original.item.sourceKind,
          receipt.original.item.stableItemId,
        ]),
      );
    if (new Set(entryIds).size !== entryIds.length)
      context.addIssue({
        code: "custom",
        message: "duplicate disposition entry",
      });
    if (new Set(requestIds).size !== requestIds.length)
      context.addIssue({
        code: "custom",
        message: "duplicate disposition request",
      });
    if (new Set(pendingFences).size !== pendingFences.length)
      context.addIssue({
        code: "custom",
        message: "duplicate pending disposition fence",
      });
  });

export type InboxDispositionOriginal = z.infer<
  typeof inboxDispositionOriginalSchema
>;
export type InboxDispositionStoredOriginal = z.infer<
  typeof inboxDispositionStoredOriginalSchema
>;
export type InboxDispositionReceipt = z.infer<
  typeof inboxDispositionReceiptSchema
>;
export type InboxDispositionEntry = z.infer<typeof inboxDispositionEntrySchema>;
export type InboxDispositionStore = z.infer<typeof inboxDispositionStoreSchema>;
