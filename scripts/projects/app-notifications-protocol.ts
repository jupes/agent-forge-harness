import { z } from "zod";

const minute = z.number().int().min(0).max(1439);
export const appNotificationPolicySchema = z
  .object({
    enabled: z.boolean(),
    quietHours: z
      .object({ startMinute: minute, endMinute: minute })
      .strict()
      .refine(
        (v) => v.startMinute !== v.endMinute,
        "Quiet hours need distinct start and end times.",
      )
      .nullable(),
  })
  .strict();
export type AppNotificationPolicy = z.infer<typeof appNotificationPolicySchema>;
export const DEFAULT_APP_NOTIFICATION_POLICY: AppNotificationPolicy = {
  enabled: true,
  quietHours: null,
};
export const appNotificationSettingsSchema = z
  .object({
    version: z.literal(1),
    revision: z
      .number()
      .int()
      .min(0)
      .max(Number.MAX_SAFE_INTEGER - 1),
    policy: appNotificationPolicySchema,
    source: z.enum(["default", "machine"]),
  })
  .strict()
  .refine(
    (value) =>
      value.source === "default"
        ? value.revision === 0 &&
          value.policy.enabled === true &&
          value.policy.quietHours === null
        : value.revision >= 1,
    "Inconsistent app notification policy provenance.",
  );
export type AppNotificationSettings = z.infer<
  typeof appNotificationSettingsSchema
>;
export const appNotificationWriteSchema = z
  .object({
    expectedRevision: z
      .number()
      .int()
      .min(0)
      .max(Number.MAX_SAFE_INTEGER - 2),
    policy: appNotificationPolicySchema,
  })
  .strict();
/** Local computer wall-clock, half-open intervals; off never affects source records. */
export function appInterruptionAllowed(
  policy: AppNotificationPolicy,
  now = new Date(),
): boolean {
  if (!policy.enabled || !Number.isFinite(now.getTime())) return false;
  const quiet = policy.quietHours;
  if (!quiet) return true;
  const current = now.getHours() * 60 + now.getMinutes(),
    start = quiet.startMinute,
    end = quiet.endMinute;
  return !(start < end
    ? current >= start && current < end
    : current >= start || current < end);
}
