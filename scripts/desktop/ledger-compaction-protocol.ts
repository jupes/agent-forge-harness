import { z } from "zod";

const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const receipt = {
  requestId: z.string().uuid(),
  startedAt: z.string().datetime(),
  cutoffAt: z.string().datetime(),
};
export const ledgerCompactionRecordSchema = z
  .object({
    version: z.literal(1),
    ledgerKey: z.string().regex(/^[a-f0-9]{64}$/),
    revision: count,
    last: z
      .discriminatedUnion("state", [
        z.object({ ...receipt, state: z.literal("pending") }).strict(),
        z
          .object({
            ...receipt,
            state: z.literal("completed"),
            events: count,
            days: count,
          })
          .strict(),
      ])
      .nullable(),
  })
  .strict()
  .refine(
    (value) => (value.revision === 0) === (value.last === null),
    "A consumed revision requires a receipt",
  )
  .refine(
    (value) =>
      !value.last ||
      Date.parse(value.last.cutoffAt) ===
        Date.parse(value.last.startedAt) - 90 * 86_400_000,
    "The receipt must use the acknowledged90day policy",
  )
  .refine(
    (value) =>
      !value.last ||
      value.last.state !== "completed" ||
      (value.last.days <= value.last.events &&
        (value.last.days === 0) === (value.last.events === 0)),
    "Completed event and day counts must agree",
  );
export type LedgerCompactionRecord = z.infer<
  typeof ledgerCompactionRecordSchema
>;
export const ledgerCompactionStatusSchema = z
  .object({
    record: ledgerCompactionRecordSchema,
    canCompact: z.boolean(),
    checkedAt: z.string().datetime(),
  })
  .strict()
  .refine(
    (value) => value.record.last?.state !== "pending" || !value.canCompact,
  );
export type LedgerCompactionStatus = z.infer<
  typeof ledgerCompactionStatusSchema
>;
export const ledgerCompactionRequestSchema = z
  .object({
    expectedLedgerKey: z.string().regex(/^[a-f0-9]{64}$/),
    requestId: z.string().uuid(),
    expectedRevision: count.max(Number.MAX_SAFE_INTEGER - 1),
    acknowledge90Days: z.literal(true),
  })
  .strict();
export type LedgerCompactionRequest = z.infer<
  typeof ledgerCompactionRequestSchema
>;
