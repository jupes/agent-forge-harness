import { z } from "zod";
import { PROJECT_COLOR_IDS } from "../../types/projects";

const text = (max: number, min = 0) =>
  z
    .string()
    .min(min)
    .max(max)
    .refine((value) => !/[\p{Cc}\p{Cs}]/u.test(value))
    .refine((value) => min === 0 || value.trim().length > 0);

export const projectGeneralSettingsSchema = z
  .object({
    name: text(120, 1),
    description: text(500),
    icon: text(16, 1),
    color: z.enum(PROJECT_COLOR_IDS).optional(),
  })
  .strict();

export const projectGeneralSettingsRequestSchema = z
  .object({
    expectedRevision: z
      .number()
      .int()
      .min(0)
      .max(Number.MAX_SAFE_INTEGER - 1),
    general: projectGeneralSettingsSchema,
  })
  .strict();

export type ProjectGeneralSettings = z.infer<
  typeof projectGeneralSettingsSchema
>;
export type ProjectGeneralSettingsRequest = z.infer<
  typeof projectGeneralSettingsRequestSchema
>;
