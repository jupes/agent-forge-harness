import { z } from "zod";

export const repositoryRequestIdSchema = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
export const projectRepositoryNameSchema = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/)
  .refine(
    (value) =>
      value !== "." &&
      value !== ".." &&
      !value.endsWith(".") &&
      !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(value),
  );
export const repositorySelectionSchema = z
  .object({
    version: z.literal(1),
    workspaceKey: z.string().min(1).max(1024),
    requestId: repositoryRequestIdSchema,
    state: z.enum(["selected", "cancelled", "rejected", "unknown"]),
    path: z.string().min(1).max(1024).nullable(),
    createdAt: z.string().datetime(),
  })
  .strict();
export const repositoryCloneSchema = z
  .object({
    version: z.literal(1),
    workspaceKey: z.string().min(1).max(1024),
    requestId: repositoryRequestIdSchema,
    name: projectRepositoryNameSchema,
    url: z.string().min(1).max(2048),
    state: z.enum([
      "reserved",
      "running",
      "clone-complete",
      "registered",
      "failed",
      "unknown",
    ]),
    path: z.string().min(1).max(1024),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();
export const approvedRepositorySchema = z
  .object({
    name: projectRepositoryNameSchema,
    path: z.string().min(1).max(1024),
    key: z.string().min(1).max(1024),
    originalRequestId: repositoryRequestIdSchema,
    source: z.enum(["folder", "clone"]),
  })
  .strict();
export const approvedRepositoryRegistrySchema = z
  .object({
    version: z.literal(1),
    repositories: z.array(approvedRepositorySchema).max(128),
  })
  .strict();

export type RepositorySelection = z.infer<typeof repositorySelectionSchema>;
export type RepositoryClone = z.infer<typeof repositoryCloneSchema>;
export type ApprovedRepository = z.infer<typeof approvedRepositorySchema>;
