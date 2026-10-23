import { z } from "zod";
import type {
  KeeperContinuationRecord,
  KeeperRecoveryPage,
  KeeperRecoveryState,
} from "../../types/keeper-recovery";

if (typeof window !== "undefined") z.config({ jitless: true });

const boundedRevision = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER - 1);
const binding = z
  .object({
    provider: z.enum(["claude", "codex", "gemini", "grok"]),
    sessionId: z.string().min(1).max(200),
    version: z.string().min(1).max(100),
  })
  .strict();
export const keeperContinuationSchema = z
  .object({
    requestId: z.string().uuid(),
    expectedRevision: boundedRevision,
    mode: z.enum(["switch", "fresh"]),
    smith: z.string().min(1).max(200),
    summary: z.string().trim().max(12_000),
  })
  .strict();
export const keeperContinuationRecordSchema: z.ZodType<KeeperContinuationRecord> =
  keeperContinuationSchema
    .extend({
      hash: z.string().regex(/^[a-f0-9]{64}$/),
      revision: boundedRevision,
      generation: z.number().int().min(1).max(100),
      sourceSequence: boundedRevision,
      at: z.iso.datetime(),
      previousBinding: binding.nullable(),
      resumed: z.boolean(),
    })
    .strict();
export const keeperRecoveryStateSchema = z
  .object({
    smith: z.string().min(1).max(200),
    generation: z.number().int().min(1).max(100),
    continuation: keeperContinuationRecordSchema,
    records: z.array(keeperContinuationRecordSchema).min(1).max(100),
  })
  .strict() satisfies z.ZodType<KeeperRecoveryState>;
const readiness = z
  .object({
    connection: z.enum(["ready", "signed-out", "adapter-missing", "unknown"]),
    allowance: z.enum(["available", "exhausted", "unreported"]),
    canStart: z.boolean(),
    source: z.string().min(1).max(200),
    asOf: z.iso.datetime(),
    reason: z.string().min(1).max(1000),
  })
  .strict();
export const keeperRecoveryPageSchema: z.ZodType<KeeperRecoveryPage> = z
  .object({
    projectId: z.string(),
    conversationRevision: boundedRevision,
    selectedSmith: z.string().min(1).max(200),
    choices: z
      .array(
        z
          .object({
            smith: z
              .object({
                name: z.string().min(1).max(200),
                provider: z.string().min(1).max(100),
                model: z.string().min(1).max(200),
                effort: z.string().max(100),
                enabled: z.boolean(),
                tags: z.array(z.string()),
              })
              .strict(),
            readiness,
          })
          .strict(),
      )
      .max(100),
    continuation: keeperContinuationRecordSchema.nullable(),
    request: keeperContinuationRecordSchema.nullable(),
  })
  .strict();
