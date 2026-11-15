import { z } from "zod";

const version = z
  .string()
  .max(100)
  .regex(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?$/);
export const nativeUpdateOperationSchema = z.enum([
  "check",
  "download",
  "install",
]);
export const nativeUpdateAuthorizationSchema = z.strictObject({
  operation: nativeUpdateOperationSchema,
  requestId: z.string().uuid(),
});
export const nativeUpdateAuthorizationResultSchema =
  nativeUpdateAuthorizationSchema.extend({
    schemaVersion: z.literal(1),
    authorized: z.literal(true),
  });
export const nativeUpdateResultSchema = z.strictObject({
  schemaVersion: z.literal(1),
  currentVersion: version,
  scopeKey: z.string().regex(/^[a-f0-9]{64}$/),
  requestId: z.string().uuid().nullable(),
  version: version.nullable(),
  state: z.enum([
    "unconfigured",
    "available",
    "current",
    "downloaded",
    "install-unknown",
    "version-observed",
    "unavailable",
    "expired",
    "not-attempted",
  ]),
});
export const nativeUpdatePendingSchema = z.strictObject({
  schemaVersion: z.literal(1),
  requestId: z.string().uuid(),
  currentVersion: version,
  version,
  scopeKey: z.string().regex(/^[a-f0-9]{64}$/),
});
export type NativeUpdateResult = z.infer<typeof nativeUpdateResultSchema>;
export type NativeUpdatePending = z.infer<typeof nativeUpdatePendingSchema>;
export type NativeUpdateAuthorization = z.infer<
  typeof nativeUpdateAuthorizationSchema
>;
export type NativeUpdateRequest =
  | NativeUpdateAuthorization
  | { operation: "status"; requestId: string | null };
