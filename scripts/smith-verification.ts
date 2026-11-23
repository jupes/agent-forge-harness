import { z } from "zod";

if (typeof window !== "undefined") z.config({ jitless: true });

export const APPRENTICE_VERIFICATION = "agent-forge-harness-cla5.6.6.1";
export const MAX_SMITH_VERIFICATION_BYTES = 262_144;
const line = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => !/[\p{Cc}\p{Cs}]/u.test(value));
const body = z
  .string()
  .max(65_536)
  .refine(
    (value) =>
      !/\p{Cs}/u.test(value) && !value.includes(String.fromCharCode(0)),
  );
const time = z.string().max(100).datetime({ offset: true });
const priority = z.number().int().min(0).max(4).nullable();

export const smithVerificationRowSchema = z.object({
  id: z.literal(APPRENTICE_VERIFICATION),
  title: line,
  status: line.max(128),
  priority: priority.optional(),
  description: body.optional(),
  acceptance_criteria: body.optional(),
  notes: body.optional(),
  updated_at: time.optional(),
});

export const smithVerificationReadSchema = z
  .object({
    workspace: line,
    checkedAt: time,
    task: z
      .object({
        id: z.literal(APPRENTICE_VERIFICATION),
        title: line,
        status: line.max(128),
        priority,
        description: body,
        acceptanceCriteria: body,
        notes: body,
        updatedAt: time.nullable(),
      })
      .strict(),
  })
  .strict();
export type SmithVerificationRead = z.infer<typeof smithVerificationReadSchema>;
