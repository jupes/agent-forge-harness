import { z } from "zod";
import type { KeeperVisibility } from "../../types/projects";
import {
  keeperScheduleInputSchema,
  keeperScheduleSavedSchema,
} from "../keeper/brief-schedule";

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

export const keeperVisibilitySchema = z.enum([
  "project-metadata",
  "conversation-only",
]);
export const DEFAULT_KEEPER_VISIBILITY: KeeperVisibility = "project-metadata";

/** Future source access only; existing admitted context is never retroactively erased. */
export function effectiveKeeperVisibility(project: {
  readonly keeperVisibility?: unknown;
}): Readonly<{
  value: KeeperVisibility;
  source: "default-policy" | "project-catalog";
}> {
  const saved = project.keeperVisibility;
  return Object.freeze({
    value:
      saved === undefined
        ? DEFAULT_KEEPER_VISIBILITY
        : keeperVisibilitySchema.parse(saved),
    source: saved === undefined ? "default-policy" : "project-catalog",
  });
}

/** Saved projection is richer than the unchanged legacy Smith/autonomy mutation. */
export const projectKeeperProjectionSchema = projectKeeperSettingsSchema
  .extend({
    keeperVisibility: keeperVisibilitySchema.optional(),
  })
  .strict();
export type ProjectKeeperProjection = z.infer<
  typeof projectKeeperProjectionSchema
>;

export const projectKeeperVisibilityRequestSchema = z
  .object({
    expectedRevision: projectKeeperSettingsRequestSchema.shape.expectedRevision,
    kind: z.literal("visibility"),
    keeperVisibility: keeperVisibilitySchema,
  })
  .strict();
export type ProjectKeeperVisibilityRequest = z.infer<
  typeof projectKeeperVisibilityRequestSchema
>;

/** The live route adopts this complete union with its visibility store operation. */
export const projectKeeperMutationRequestSchema = z.union([
  projectKeeperSettingsRequestSchema,
  projectKeeperVisibilityRequestSchema,
]);
export type ProjectKeeperMutationRequest = z.infer<
  typeof projectKeeperMutationRequestSchema
>;

/** Additive contracts; live consumers adopt these only with exhaustive schedule handling. */
export const projectKeeperProjectionWithScheduleSchema =
  projectKeeperProjectionSchema
    .extend({ keeperSchedule: keeperScheduleSavedSchema.optional() })
    .strict();
export type ProjectKeeperProjectionWithSchedule = z.infer<
  typeof projectKeeperProjectionWithScheduleSchema
>;
export const projectKeeperScheduleRequestSchema = z
  .object({
    expectedRevision: projectKeeperSettingsRequestSchema.shape.expectedRevision,
    kind: z.literal("schedule"),
    keeperSchedule: keeperScheduleInputSchema,
  })
  .strict();
export type ProjectKeeperScheduleRequest = z.infer<
  typeof projectKeeperScheduleRequestSchema
>;
export const projectKeeperMutationWithScheduleRequestSchema = z.union([
  projectKeeperMutationRequestSchema,
  projectKeeperScheduleRequestSchema,
]);
export type ProjectKeeperMutationWithScheduleRequest = z.infer<
  typeof projectKeeperMutationWithScheduleRequestSchema
>;
