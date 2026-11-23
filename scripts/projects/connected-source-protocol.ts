import { z } from "zod";
import { trackerIdentitySchema } from "./complete-tracker-source";

export const SOURCE_RESPONSE_BYTES = 1024 * 1024;
export const SOURCE_MAX_REQUESTS = 64;
export const SOURCE_MAX_GRANTS = 64;
export const SOURCE_MAX_WORKSPACES = 32;
export const sourceRefSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const sourceProjectIdSchema = z
  .string()
  .regex(
    /^project-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
export const sourceEpicIdsSchema = z
  .array(
    z
      .string()
      .min(1)
      .max(200)
      .refine((value) => !/[\p{Cc}\p{Cs}]/u.test(value)),
  )
  .max(64)
  .refine((ids) => new Set(ids).size === ids.length);
export const sourceInstanceSchema = z
  .object({
    version: z.literal(1),
    instanceId: z.uuid(),
    root: z.string().min(1).max(4096),
    pid: z.number().int().positive(),
    tracker: trackerIdentitySchema,
  })
  .strict();
export type SourceInstanceIdentity = z.infer<typeof sourceInstanceSchema>;
export const sourcePreviewSchema = z
  .object({
    instance: sourceInstanceSchema,
    projectId: sourceProjectIdSchema,
    catalogRevision: z.number().int().safe().nonnegative(),
    workspaceRef: sourceRefSchema,
    epicIds: sourceEpicIdsSchema,
    scopeCount: z.number().int().min(0).max(100000),
    scopeHash: sourceRefSchema,
    sourceAsOf: z.iso.datetime({ offset: true }),
    epics: z
      .array(
        z
          .object({
            id: z.string().min(1).max(200),
            title: z.string().min(1).max(8192),
          })
          .strict(),
      )
      .max(1000),
  })
  .strict();
export type ConnectedScopePreview = z.infer<typeof sourcePreviewSchema>;
export const sourceAuthorizeSchema = z
  .object({
    requestId: z.uuid(),
    workspaceRef: sourceRefSchema,
    expectedRevision: z.number().int().safe().nonnegative(),
  })
  .strict();
export type SourceAuthorization = z.infer<typeof sourceAuthorizeSchema>;
export const sourceAuthorizationReceiptSchema = z
  .object({
    requestId: z.uuid(),
    projectId: sourceProjectIdSchema,
    workspaceRef: sourceRefSchema,
    state: z.enum(["authorized", "cancelled", "unavailable", "pending"]),
    grantId: z.uuid().nullable(),
    reason: z.string().max(2048).nullable(),
  })
  .strict()
  .refine((value) =>
    value.state === "authorized"
      ? value.grantId !== null && value.reason === null
      : value.grantId === null && value.reason !== null,
  );
export type SourceAuthorizationReceipt = z.infer<
  typeof sourceAuthorizationReceiptSchema
>;
export const sourceRevokeSchema = z.object({ grantId: z.uuid() }).strict();

export const authorizedSourcePreviewSchema = sourcePreviewSchema.extend({
  grantId: z.uuid(),
});
export const sourceListSchema = z
  .object({
    projectId: sourceProjectIdSchema,
    catalogRevision: z.number().int().safe().nonnegative(),
    controllerId: z.uuid(),
    nativeAuthorizationAvailable: z.boolean(),
    remainingAuthorizationRequests: z
      .number()
      .int()
      .min(0)
      .max(SOURCE_MAX_REQUESTS),
    workspaces: z
      .array(
        z
          .object({
            workspaceRef: sourceRefSchema,
            root: z.string().min(1).max(4096),
            epicIds: sourceEpicIdsSchema,
            authority: z.enum(["served", "authorized", "not-authorized"]),
            grantId: z.uuid().nullable(),
          })
          .strict(),
      )
      .max(SOURCE_MAX_WORKSPACES),
  })
  .strict();
export type SourceList = z.infer<typeof sourceListSchema>;
export type AuthorizedSourcePreview = z.infer<
  typeof authorizedSourcePreviewSchema
>;
