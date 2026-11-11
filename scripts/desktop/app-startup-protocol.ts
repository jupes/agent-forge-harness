import { z } from "zod";

const key = z.string().regex(/^[a-f0-9]{64}$/);
export const startupRegistrationSchema = z.enum([
  "enabled",
  "disabled",
  "conflict",
]);
export type StartupRegistration = z.infer<typeof startupRegistrationSchema>;
export const startupRequestSchema = z
  .object({
    requestId: z.string().uuid(),
    installationKey: key,
    expectedRevision: z
      .number()
      .int()
      .min(0)
      .max(Number.MAX_SAFE_INTEGER - 1),
    expectedFingerprint: z.union([key, z.literal("absent")]),
    enabled: z.boolean(),
  })
  .strict();
export type StartupRequest = z.infer<typeof startupRequestSchema>;
export const startupReceiptSchema = z
  .object({
    request: startupRequestSchema,
    startedAt: z.string().datetime(),
    state: z.enum(["pending", "completed", "refused"]),
  })
  .strict();
export const startupRecordSchema = z
  .object({
    version: z.literal(1),
    revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    last: startupReceiptSchema.nullable(),
  })
  .strict()
  .refine((value) =>
    value.last === null
      ? value.revision === 0
      : value.revision === value.last.request.expectedRevision + 1,
  );
export type StartupRecord = z.infer<typeof startupRecordSchema>;
export const startupStatusSchema = z.union([
  z.object({ capability: z.literal("unsupported") }).strict(),
  z
    .object({
      capability: z.literal("available"),
      installationKey: key,
      registration: startupRegistrationSchema,
      fingerprint: z.union([key, z.literal("absent"), z.null()]),
      record: startupRecordSchema,
      checkedAt: z.string().datetime(),
      canSave: z.boolean(),
    })
    .strict()
    .refine(
      (value) =>
        (value.registration === "conflict") === (value.fingerprint === null),
    )
    .refine(
      (value) =>
        value.registration !== "enabled" ||
        value.fingerprint === value.installationKey,
    )
    .refine(
      (value) =>
        value.registration !== "disabled" || value.fingerprint === "absent",
    )
    .refine((value) => value.record.last?.state !== "pending" || !value.canSave)
    .refine((value) => value.registration !== "conflict" || !value.canSave),
]);
export type StartupStatus = z.infer<typeof startupStatusSchema>;
export interface StartupObservation {
  installationKey: string;
  coordinationHome: string;
  registration: StartupRegistration;
}
export interface StartupBackend {
  read(signal: AbortSignal): Promise<StartupObservation>;
  set(
    enabled: boolean,
    expected: "enabled" | "disabled",
    signal: AbortSignal,
  ): Promise<{
    outcome: "completed" | "refused" | "unconfirmed";
    observation: StartupObservation | null;
  }>;
}
