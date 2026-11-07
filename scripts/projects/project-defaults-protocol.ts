import { z } from "zod";

export const projectDefaultsSchema = z
  .object({
    claudeSessionSmith: z
      .string()
      .min(1)
      .max(80)
      .refine(
        (value) => value.trim() === value && !/[\p{Cc}\p{Cs}]/u.test(value),
      )
      .optional(),
  })
  .strict();
export const projectDefaultsRequestSchema = z
  .object({
    expectedRevision: z
      .number()
      .int()
      .min(0)
      .max(Number.MAX_SAFE_INTEGER - 1),
    defaults: projectDefaultsSchema,
  })
  .strict();
export type ProjectDefaults = z.infer<typeof projectDefaultsSchema>;
