import { z } from "zod";
import { LEDGER_EVENT_KINDS } from "../../types/hearth";

if (typeof window !== "undefined") z.config({ jitless: true });
export const HEARTH_LOG_LIMITS = Object.freeze({
  retained: 256,
  returned: 128,
  responseBytes: 65_536,
});
export const hearthLogCodeSchema = z.enum([
  "runtime.created",
  "runtime.listening",
  "runtime.stopping",
  "ledger.inserted",
  "ledger.duplicate",
  "ledger.failed",
  "ledger.thrown",
  "ledger.unverified",
]);
export type HearthLogCode = z.infer<typeof hearthLogCodeSchema>;
export const HEARTH_LOG_MESSAGES: Readonly<Record<HearthLogCode, string>> =
  Object.freeze({
    "runtime.created": "Hearth service runtime prepared.",
    "runtime.listening": "Hearth is listening with its owned lock and token.",
    "runtime.stopping": "Hearth stop began; this does not confirm cleanup.",
    "ledger.inserted": "Ledger append reported a stored row.",
    "ledger.duplicate":
      "Ledger append reported an existing event; no new row was confirmed.",
    "ledger.failed":
      "Ledger append returned a failure; no stored row was confirmed.",
    "ledger.thrown":
      "Ledger appender threw without reporting a result; outcome is unconfirmed.",
    "ledger.unverified": "Ledger append metadata could not be verified.",
  });
export const hearthLogLevel = (code: HearthLogCode) =>
  code === "ledger.failed" ||
  code === "ledger.thrown" ||
  code === "ledger.unverified"
    ? ("warning" as const)
    : ("info" as const);
const sequence = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const hearthLogEntrySchema = z
  .object({
    sequence: sequence.refine((value) => value > 0),
    at: z.iso.datetime(),
    code: hearthLogCodeSchema,
    level: z.enum(["info", "warning"]),
    eventKind: z.enum(LEDGER_EVENT_KINDS).nullable(),
  })
  .strict()
  .refine(
    (value) =>
      value.level === hearthLogLevel(value.code) &&
      (!value.code.startsWith("runtime.") || value.eventKind === null),
  );
export type HearthLogEntry = z.infer<typeof hearthLogEntrySchema>;
export const hearthLogSnapshotSchema = z
  .object({
    version: z.literal(1),
    generation: z.uuid().refine((value) => value === value.toLowerCase()),
    startedAt: z.iso.datetime(),
    checkedAt: z.iso.datetime(),
    latestSequence: sequence,
    retainedCount: z.number().int().min(0).max(HEARTH_LOG_LIMITS.retained),
    evictedCount: sequence,
    omittedRetainedCount: z
      .number()
      .int()
      .min(0)
      .max(HEARTH_LOG_LIMITS.retained),
    entries: z.array(hearthLogEntrySchema).max(HEARTH_LOG_LIMITS.returned),
  })
  .strict()
  .refine(
    (value) =>
      value.retainedCount ===
        Math.min(value.latestSequence, HEARTH_LOG_LIMITS.retained) &&
      value.latestSequence === value.retainedCount + value.evictedCount &&
      value.entries.length ===
        Math.min(value.retainedCount, HEARTH_LOG_LIMITS.returned) &&
      value.omittedRetainedCount ===
        value.retainedCount - value.entries.length &&
      value.entries.every(
        (entry, index) =>
          entry.sequence ===
          value.latestSequence - value.entries.length + 1 + index,
      ),
  )
  .refine(
    (value) =>
      new TextEncoder().encode(JSON.stringify(value)).byteLength <=
      HEARTH_LOG_LIMITS.responseBytes,
  );
export type HearthLogSnapshot = z.infer<typeof hearthLogSnapshotSchema>;
