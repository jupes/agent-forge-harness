import { z } from "zod";

const safeId = z
  .string()
  .min(1)
  .max(200)
  .refine((value) => !/[\p{Cc}\p{Cs}]/u.test(value));

export const projectScopePreviewSettingsQuerySchema = z
  .object({
    revision: z.number().safe().int().nonnegative(),
    epicIds: z
      .array(safeId)
      .max(64)
      .refine((ids) => new Set(ids).size === ids.length),
  })
  .strict();

export const projectScopePreviewSettingsSchema = z
  .object({
    complete: z.literal(true),
    projectId: z
      .string()
      .regex(/^project-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
    catalogRevision: z.number().safe().int().nonnegative(),
    workspaceKey: z.string().min(1).max(1024).refine((value) => !/[\p{Cc}\p{Cs}]/u.test(value)),
    slug: z.string().min(1).max(48).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    epicIds: z.array(safeId).max(64).refine(
      (ids) =>
        new Set(ids).size === ids.length &&
        ids.every((id, index) => index === 0 || ids[index - 1]! < id),
    ),
    scopeCount: z.number().safe().int().min(0).max(100_000),
    scopeHash: z.string().regex(/^[a-f0-9]{64}$/),
    sourceAsOf: z.string().datetime({ offset: true }),
  })
  .strict();

export type ProjectScopePreviewSettingsQuery = z.infer<
  typeof projectScopePreviewSettingsQuerySchema
>;
export type ProjectScopePreviewSettings = z.infer<
  typeof projectScopePreviewSettingsSchema
>;
