import { join } from "node:path";
import { ensurePrivateHome, readHomeFileBounded } from "../hearth/home-guard";
import { writeOwnerOnly } from "../hearth/token";
import { withQueueLock } from "../scheduler/queue-lock";
import {
  type AppNotificationSettings,
  appNotificationSettingsSchema,
  appNotificationWriteSchema,
  DEFAULT_APP_NOTIFICATION_POLICY,
} from "./app-notifications-protocol";
export class AppNotificationSettingsError extends Error {
  constructor(
    readonly status: 400 | 409 | 503 | 504,
    message: string,
  ) {
    super(message);
  }
}
const MARKER = "app-notifications-v1\n";
export const appNotificationSettingsPath = (home: string) =>
  join(home, "notification-settings.json");
export function createAppNotificationStore(home: string) {
  const file = appNotificationSettingsPath(home),
    marker = join(home, "notification-settings.initialized");
  const read = (): AppNotificationSettings => {
    const stored = readHomeFileBounded(home, file, 4096),
      initialized = readHomeFileBounded(home, marker, 64);
    if (stored.problem || initialized.problem)
      throw new AppNotificationSettingsError(
        503,
        "Private notification settings are unavailable.",
      );
    if (stored.text === null && initialized.text === null)
      return {
        version: 1,
        revision: 0,
        policy: structuredClone(DEFAULT_APP_NOTIFICATION_POLICY),
        source: "default",
      };
    if (initialized.text !== MARKER || stored.text === null)
      throw new AppNotificationSettingsError(
        503,
        "Saved notification settings are missing or incomplete. Interruption is held.",
      );
    try {
      const value = appNotificationSettingsSchema.parse(
        JSON.parse(stored.text),
      );
      if (value.source !== "machine" || value.revision < 1)
        throw Error("Invalid stored policy provenance");
      return value;
    } catch {
      throw new AppNotificationSettingsError(
        503,
        "Saved notification settings are invalid. Interruption is held.",
      );
    }
  };
  return {
    read,
    async write(raw: unknown) {
      const parsed = appNotificationWriteSchema.safeParse(raw);
      if (!parsed.success)
        throw new AppNotificationSettingsError(
          400,
          "Invalid app notification settings.",
        );
      ensurePrivateHome(home);
      let attempted = false;
      try {
        const result = await withQueueLock(
          join(home, "notification-settings.lock"),
          async () => {
            const current = read();
            if (current.revision !== parsed.data.expectedRevision)
              throw new AppNotificationSettingsError(
                409,
                "App notification settings changed. Check the current values before saving again.",
              );
            const next: AppNotificationSettings = {
              version: 1,
              revision: current.revision + 1,
              policy: parsed.data.policy,
              source: "machine",
            };
            attempted = true;
            writeOwnerOnly(marker, MARKER);
            writeOwnerOnly(file, JSON.stringify(next));
            return read();
          },
          { waitMs: 1000 },
        );
        if (!result.ok)
          throw new AppNotificationSettingsError(
            503,
            "App notification settings are busy or unavailable.",
          );
        return result.value;
      } catch (error) {
        if (attempted)
          throw new AppNotificationSettingsError(
            504,
            "Notification settings may have changed. Check current values before saving again.",
          );
        throw error;
      }
    },
  };
}
