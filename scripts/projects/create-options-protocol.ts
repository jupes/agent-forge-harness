import { z } from "zod";
import { workspaceKey } from "./scope";

export const MAX_PROJECT_CREATE_OPTION_REPOSITORIES = 128;
export const MAX_PROJECT_CREATE_OPTION_EPICS = 4_096;
export const MAX_PROJECT_CREATE_OPTIONS_BYTES = 1024 * 1024;
export const MAX_PROJECT_SCOPE_PREVIEW_EPICS = 64;

const safeText = z
  .string()
  .min(1)
  .max(1024)
  .refine((value) => !/[\p{Cc}\p{Cs}]/u.test(value));
const absolutePath = safeText.refine(
  (value) =>
    value.startsWith("/") ||
    /^[a-z]:[\\/]/i.test(value) ||
    value.startsWith("\\\\"),
);
const projectSlug = z
  .string()
  .min(1)
  .max(48)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

const workspaceOption = z
  .object({ path: absolutePath, key: absolutePath })
  .strict()
  .refine((value) => workspaceKey(value.path) === value.key);

const repositoryOption = z
  .object({
    path: absolutePath,
    key: absolutePath,
    name: safeText,
    served: z.boolean(),
  })
  .strict()
  .refine((value) => workspaceKey(value.path) === value.key);

const epicOption = z
  .object({
    id: safeText.max(200),
    title: safeText,
    parentId: safeText.max(200).nullable(),
  })
  .strict();

export const projectCreateOptionsSchema = z
  .object({
    complete: z.literal(true),
    workspace: workspaceOption,
    repositories: z
      .array(repositoryOption)
      .min(1)
      .max(MAX_PROJECT_CREATE_OPTION_REPOSITORIES),
    epics: z.array(epicOption).max(MAX_PROJECT_CREATE_OPTION_EPICS),
  })
  .strict()
  .superRefine((value, context) => {
    const served = value.repositories.filter((repository) => repository.served);
    if (
      served.length !== 1 ||
      served[0]?.key !== value.workspace.key ||
      new Set(value.repositories.map((repository) => repository.key)).size !==
        value.repositories.length ||
      new Set(value.epics.map((epic) => epic.id)).size !== value.epics.length
    )
      context.addIssue({ code: "custom", message: "Inconsistent options." });
  });

export const projectScopePreviewQuerySchema = z
  .object({
    slug: projectSlug,
    epicIds: z
      .array(safeText.max(200))
      .min(1)
      .max(MAX_PROJECT_SCOPE_PREVIEW_EPICS)
      .refine((epicIds) => new Set(epicIds).size === epicIds.length),
  })
  .strict();

export const projectScopePreviewSchema = z
  .object({
    complete: z.literal(true),
    workspaceKey: safeText,
    slug: projectSlug,
    epicIds: z
      .array(safeText.max(200))
      .min(1)
      .max(MAX_PROJECT_SCOPE_PREVIEW_EPICS)
      .refine(
        (epicIds) =>
          new Set(epicIds).size === epicIds.length &&
          epicIds.every((id, index) => index === 0 || epicIds[index - 1]! < id),
      ),
    scopeCount: z.number().int().min(0).max(100_000),
    scopeHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

export type ProjectCreateOptions = z.infer<typeof projectCreateOptionsSchema>;
export type ProjectScopePreviewQuery = z.infer<
  typeof projectScopePreviewQuerySchema
>;
export type ProjectScopePreview = z.infer<typeof projectScopePreviewSchema>;
