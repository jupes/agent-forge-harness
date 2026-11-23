import { z } from "zod";

/** Injected by the host. A domain lease precedes this fence; execution follows its release. */
export type ProjectAdmissionFence = <T>(
  projectId: string,
  publish: () => T | Promise<T>,
) => Promise<T>;

export const projectDeletionRequestSchema = z
  .object({
    requestId: z
      .string()
      .uuid()
      .refine((value) => value === value.toLowerCase()),
    expectedRevision: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER - 1),
    confirmName: z.string().min(1).max(120),
  })
  .strict();
export type ProjectDeletionRequest = z.infer<
  typeof projectDeletionRequestSchema
>;
export function canonicalProjectDeletion(
  projectId: string,
  request: ProjectDeletionRequest,
): string {
  return JSON.stringify({
    family: "project-delete",
    version: 1,
    projectId,
    requestId: request.requestId,
    expectedRevision: request.expectedRevision,
    confirmName: request.confirmName,
  });
}
export const projectDeletionReceiptSchema = z
  .object({
    projectId: z.string().regex(/^project-[0-9a-f-]{36}$/),
    requestId: z.string().uuid(),
    requestHash: z.string().regex(/^[a-f0-9]{64}$/),
    name: z.string().min(1).max(120),
    slug: z.string().min(1).max(48),
    deletedRevision: z.number().int().positive(),
    deletedAt: z.iso.datetime(),
  })
  .strict();
export type ProjectDeletionReceipt = z.infer<
  typeof projectDeletionReceiptSchema
>;
export const projectDeletionStatusSchema = z
  .object({
    projectId: z.string(),
    catalogRevision: z.number().int().nonnegative(),
    asOf: z.iso.datetime(),
    archived: z.boolean(),
    state: z.enum(["eligible", "active", "unknown", "archive-required"]),
    reasons: z.array(z.string().min(1).max(300)).max(20),
  })
  .strict();
export type ProjectDeletionStatus = z.infer<typeof projectDeletionStatusSchema>;
