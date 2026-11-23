import { z } from "zod";
import { PROJECT_COLOR_IDS } from "../../types/projects";

if (typeof window !== "undefined") z.config({ jitless: true });

export const MAX_PROJECT_CREATE_OPERATIONS = 256;

const text = z
  .string()
  .max(1024)
  .refine((value) => !/[\p{Cc}\p{Cs}]/u.test(value));
const absolutePath = text.refine(
  (value) =>
    value.startsWith("/") ||
    /^[a-z]:[\\/]/i.test(value) ||
    value.startsWith("\\\\"),
  "Expected an absolute checkout path.",
);
const epicId = text.min(1).max(200);
const requestId = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const projectId = z
  .string()
  .regex(
    /^project-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );

export const projectCreateOriginalSchema = z
  .object({
    slug: z
      .string()
      .min(1)
      .max(48)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    name: text.min(1).max(120),
    description: text.max(500),
    icon: text.min(1).max(16),
    keeperSmith: text.min(1).optional(),
    color: z.enum(PROJECT_COLOR_IDS).optional(),
    workspaces: z
      .array(
        z
          .object({
            root: absolutePath,
            repositories: z
              .array(absolutePath)
              .min(1)
              .max(32)
              .refine((items) => new Set(items).size === items.length),
            epicIds: z
              .array(epicId)
              .min(1)
              .max(64)
              .refine((items) => new Set(items).size === items.length),
          })
          .strict(),
      )
      .length(1),
  })
  .strict();

export const projectCreateReserveSchema = z
  .object({
    requestId,
    expectedCatalogRevision: z
      .number()
      .int()
      .min(0)
      .max(Number.MAX_SAFE_INTEGER - 1),
    original: projectCreateOriginalSchema,
  })
  .strict();

export const projectCreateCommitSchema = z
  .object({
    requestHash: digest,
    reviewedScopeHash: digest,
  })
  .strict();

export const projectCreateRetireSchema = z
  .object({ requestHash: digest })
  .strict();

export const projectCreateIdentitySchema = z
  .object({
    requestId,
    requestHash: digest,
    original: projectCreateOriginalSchema,
    baseRevision: z
      .number()
      .int()
      .min(0)
      .max(Number.MAX_SAFE_INTEGER - 1),
    scopeHash: digest,
    scopeCount: z.number().int().min(0).max(100_000),
    state: z.enum(["reserved", "created", "retired-before-create"]),
    projectId: projectId.nullable(),
    createdRevision: z
      .number()
      .int()
      .min(0)
      .max(Number.MAX_SAFE_INTEGER - 1)
      .nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict()
  .refine(
    (value) =>
      value.state === "created"
        ? value.projectId !== null && value.createdRevision !== null
        : value.projectId === null && value.createdRevision === null,
    "Create identity state and project receipt do not agree.",
  );

export const projectCreateDiscoveryRowSchema = z
  .object({
    requestId,
    requestHash: digest,
    state: z.enum(["reserved", "created", "retired-before-create"]),
    scopeCount: z.number().int().min(0).max(100_000),
    projectId: projectId.nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();

export const projectCreateDiscoverySchema = z
  .object({
    complete: z.literal(true),
    operations: z
      .array(projectCreateDiscoveryRowSchema)
      .max(MAX_PROJECT_CREATE_OPERATIONS),
  })
  .strict();

export type ProjectCreateOriginal = z.infer<typeof projectCreateOriginalSchema>;
export type ProjectCreateReserveRequest = z.infer<
  typeof projectCreateReserveSchema
>;
export type ProjectCreateIdentity = z.infer<typeof projectCreateIdentitySchema>;
export type ProjectCreateDiscovery = z.infer<
  typeof projectCreateDiscoverySchema
>;
