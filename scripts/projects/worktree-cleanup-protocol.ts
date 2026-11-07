import { z } from "zod";

const text = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((value) => !/[\p{Cc}\p{Cs}]/u.test(value));
const uuid = z
  .string()
  .uuid()
  .refine((value) => value === value.toLowerCase());
export const cleanupRequestSchema = z
  .object({
    requestId: uuid,
    repository: text(1024),
    expectedCatalogRevision: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER),
    expectedRecord: z
      .object({
        id: text(128).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
        path: text(1024),
        branch: text(256),
        createdAt: z.iso.datetime(),
        beadId: text(128).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
      })
      .strict(),
    expectedHead: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
  })
  .strict();
export type CleanupRequest = z.infer<typeof cleanupRequestSchema>;

/** Fixed native spelling and field order; host hashing never enters this module. */
export function canonicalCleanupRequest(
  projectId: string,
  request: CleanupRequest,
): string {
  const row = request.expectedRecord;
  return JSON.stringify({
    family: "project-worktree-cleanup",
    version: 1,
    projectId,
    requestId: request.requestId,
    repository: request.repository,
    expectedCatalogRevision: request.expectedCatalogRevision,
    expectedRecord: {
      id: row.id,
      path: row.path,
      branch: row.branch,
      createdAt: row.createdAt,
      beadId: row.beadId,
    },
    expectedHead: request.expectedHead,
  });
}
