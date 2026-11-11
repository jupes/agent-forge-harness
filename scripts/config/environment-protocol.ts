import { z } from "zod";

if (typeof window !== "undefined") z.config({ jitless: true });

export const environmentNamesSchema = z
  .array(
    z
      .string()
      .max(128)
      .regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
  )
  .max(256)
  .refine(
    (names) =>
      new Set(names.map((name) => name.toUpperCase())).size === names.length,
  );

export const ENVIRONMENT_LIMITS = Object.freeze({
  sourceBytes: 1_048_576,
  requestBytes: 40_960,
  recordBytes: 49_152,
  responseBytes: 98_304,
});
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const sequence = z
  .number()
  .int()
  .min(0)
  .max(Number.MAX_SAFE_INTEGER - 1);
const within = (value: unknown, max: number) =>
  new TextEncoder().encode(JSON.stringify(value)).byteLength <= max;
export const environmentRevisionSchema = z
  .object({ user: hash, workspace: hash })
  .strict();
export const environmentRequestSchema = z
  .object({
    requestId: z.uuid().refine((id) => id === id.toLowerCase()),
    ownerKey: hash,
    expectedRevision: environmentRevisionSchema,
    expectedJournalRevision: sequence,
    names: environmentNamesSchema,
  })
  .strict()
  .refine((value) => within(value, ENVIRONMENT_LIMITS.requestBytes));
export type EnvironmentRequest = z.infer<typeof environmentRequestSchema>;
export const environmentRecordSchema = z
  .object({
    version: z.literal(1),
    revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    last: z
      .object({
        request: environmentRequestSchema,
        candidateHash: hash,
        startedAt: z.iso.datetime(),
        finishedAt: z.iso.datetime().nullable(),
        state: z.enum(["pending", "completed", "refused"]),
      })
      .strict()
      .nullable(),
  })
  .strict()
  .refine((record) =>
    record.last === null
      ? record.revision === 0
      : record.revision === record.last.request.expectedJournalRevision + 1 &&
        (record.last.state === "pending") === (record.last.finishedAt === null),
  )
  .refine((value) => within(value, ENVIRONMENT_LIMITS.recordBytes));
export type EnvironmentRecord = z.infer<typeof environmentRecordSchema>;
export const environmentStatusSchema = z
  .object({
    version: z.literal(1),
    ownerKey: hash,
    target: z.enum(["user", "workspace"]),
    file: z.string().min(1).max(4096),
    names: environmentNamesSchema,
    provenance: z.string().min(1).max(4096),
    baseNames: environmentNamesSchema,
    revision: environmentRevisionSchema,
    record: environmentRecordSchema,
    checkedAt: z.iso.datetime(),
    canSave: z.boolean(),
  })
  .strict()
  .refine((value) => !value.canSave || value.record.last?.state !== "pending")
  .refine((value) => within(value, ENVIRONMENT_LIMITS.responseBytes));
export type EnvironmentStatus = z.infer<typeof environmentStatusSchema>;
