import { z } from "zod";
import type { ShiftTurnSnapshot } from "../../types/shift-turn";

if (typeof window !== "undefined") z.config({ jitless: true });
const text = z
  .string()
  .min(1)
  .refine((value) => !/[\p{Cc}\p{Cs}]/u.test(value));
const word = text.max(200);
const path = text
  .max(4096)
  .refine(
    (value) =>
      /^(?:\/|[a-zA-Z]:[\\/]|\\\\[^\\]+\\[^\\]+)/.test(value) &&
      !value.split(/[\\/]/).some((part) => part === "." || part === ".."),
  );
const uuid = z.uuid().refine((value) => value === value.toLowerCase());
const snapshot = z
  .object({
    version: z.literal(1),
    projectId: word.regex(
      /^project-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    ),
    originalRequestId: uuid,
    shiftId: word.regex(/^shift-\d{8}-\d{6}-[0-9a-f]{4}$/),
    runId: word.regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
    beadId: word,
    attempt: z.number().int().positive().max(1000),
    conversationId: z
      .string()
      .refine(
        (value) =>
          value.startsWith("session-") &&
          uuid.safeParse(value.slice(8)).success,
      ),
    turnId: uuid,
    provider: z.enum(["claude", "codex"]),
    cliVersion: word.max(100).regex(/^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/),
    workspace: path,
    cwd: path,
    smith: word.max(64).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
    requestedModel: word,
    requestedEffort: word,
    command: z
      .array(
        z
          .string()
          .min(1)
          .max(16_384)
          .refine(
            (value) =>
              !value.includes("\0") &&
              !/^--(?:api[-_]?key|access[-_]?token|auth[-_]?token|bearer)(?:=|$)/i.test(
                value,
              ),
          ),
      )
      .min(1)
      .max(128),
    stdin: z
      .string()
      .min(1)
      .max(16_384)
      .refine((value) => !!value.trim() && !value.includes("\0")),
    timeoutMs: z
      .number()
      .int()
      .positive()
      .max(7 * 86_400_000),
  })
  .strict()
  .refine(
    (value) =>
      new TextEncoder().encode(JSON.stringify(value)).length <= 262_144,
  );

export const shiftTurnSnapshotSchema: z.ZodType<ShiftTurnSnapshot> = snapshot;
