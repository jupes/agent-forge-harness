import { z } from "zod";

export const keeperAutonomySchema = z.enum([
  "suggest-only",
  "propose-for-approval",
]);

export const projectKeeperSettingsSchema = z
  .object({
    keeperAutonomy: keeperAutonomySchema.optional(),
    keeperSmith: z
      .string()
      .min(1)
      .max(1024)
      .refine(
        (value) => value.trim().length > 0 && !/[\p{Cc}\p{Cs}]/u.test(value),
      )
      .optional(),
  })
  .strict();
export const projectKeeperSettingsRequestSchema = z
  .object({
    expectedRevision: z
      .number()
      .int()
      .min(0)
      .max(Number.MAX_SAFE_INTEGER - 1),
    keeper: projectKeeperSettingsSchema,
  })
  .strict();
export type ProjectKeeperSettings = z.infer<typeof projectKeeperSettingsSchema>;
