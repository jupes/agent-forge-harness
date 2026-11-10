import { z } from "zod";

export const ledgerBackupScheduleSchema = z
  .object({
    phase: z.enum(["inactive", "scheduled", "stopped"]),
    nextAttemptAt: z.string().datetime().nullable(),
    lastAttempt: z
      .object({
        startedAt: z.string().datetime(),
        outcome: z.enum(["completed", "unconfirmed"]),
      })
      .strict()
      .nullable(),
  })
  .strict()
  .refine(
    (value) => (value.phase === "scheduled") === (value.nextAttemptAt !== null),
    "Scheduled backups require a next attempt time",
  );
export type LedgerBackupSchedule = z.infer<typeof ledgerBackupScheduleSchema>;

const fileSizeSchema = z.discriminatedUnion("state", [
  z
    .object({
      state: z.literal("available"),
      bytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    })
    .strict(),
  z.object({ state: z.literal("missing") }).strict(),
  z.object({ state: z.literal("unknown") }).strict(),
]);
const environmentName = z
  .string()
  .max(128)
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/);
export const appHearthSettingsSchema = z
  .object({
    version: z.literal(1),
    checkedAt: z.string().datetime(),
    port: z.number().int().min(1).max(65535).nullable(),
    apiVersion: z.number().int().positive(),
    ledger: z
      .object({
        path: z.string().min(1).max(32768),
        database: fileSizeSchema,
        wal: fileSizeSchema,
        sharedMemory: fileSizeSchema,
      })
      .strict(),
    upkeep: z
      .object({
        backupKeepDays: z.number().int().positive(),
        retentionDays: z.number().int().positive(),
        backupTrigger: z.literal("session-start-if-due"),
        nightlyBackup: ledgerBackupScheduleSchema.nullable(),
        compactionTrigger: z.literal("manual"),
      })
      .strict(),
    execution: z.discriminatedUnion("state", [
      z
        .object({
          state: z.literal("available"),
          names: z.array(environmentName).max(256),
        })
        .strict(),
      z.object({ state: z.literal("unavailable") }).strict(),
    ]),
  })
  .strict();
export type AppHearthSettings = z.infer<typeof appHearthSettingsSchema>;
