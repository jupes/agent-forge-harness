import { z } from "zod";

export const projectWorktreeFactSchema = z
  .object({
    path: z.string().min(1).max(1024),
    kind: z.enum(["trees", "claude", "other"]),
    branch: z.string().max(1024).nullable(),
    missing: z.boolean(),
    id: z.string().min(1).max(64).optional(),
    createdAt: z.string().datetime().optional(),
  })
  .strict();
export const projectRepositoryMemberSchema = z.discriminatedUnion("access", [
  z
    .object({
      path: z.string().min(1).max(1024),
      access: z.literal("unregistered"),
    })
    .strict(),
  z
    .object({
      path: z.string().min(1).max(1024),
      access: z.enum(["served", "approved"]),
      name: z.string().min(1).max(80),
      worktrees: z.array(projectWorktreeFactSchema).max(4096),
    })
    .strict(),
]);
export const projectRepositoryRowSchema = z
  .object({
    workspaceRoot: z.string().min(1).max(1024),
    repositories: z.array(projectRepositoryMemberSchema).max(128),
  })
  .strict();
export const projectRepositoriesDataSchema = z
  .object({
    projectId: z.string().min(1).max(128),
    catalogRevision: z.number().int().nonnegative().safe(),
    repositories: z.array(projectRepositoryRowSchema).max(100),
  })
  .strict();

export type ProjectWorktreeFact = z.infer<typeof projectWorktreeFactSchema>;
export type ProjectRepositoryMember = z.infer<
  typeof projectRepositoryMemberSchema
>;
export type ProjectRepositoryRow = z.infer<typeof projectRepositoryRowSchema>;
export type ProjectRepositoriesData = z.infer<
  typeof projectRepositoriesDataSchema
>;
