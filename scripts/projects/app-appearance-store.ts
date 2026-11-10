import { join } from "node:path";
import { ensurePrivateHome, readHomeFileBounded } from "../hearth/home-guard";
import { writeOwnerOnly } from "../hearth/token";
import { withQueueLock } from "../scheduler/queue-lock";
import {
  type AppAppearanceSettings,
  appAppearanceSettingsSchema,
  appAppearanceWriteSchema,
  DEFAULT_APP_APPEARANCE,
} from "./app-appearance-protocol";

export class AppAppearanceSettingsError extends Error {
  constructor(
    readonly status: 400 | 409 | 503 | 504,
    message: string,
  ) {
    super(message);
  }
}
const MARKER = "app-appearance-v1\n";
export const appAppearanceSettingsPath = (home: string) =>
  join(home, "appearance-settings.json");
export function createAppAppearanceStore(home: string) {
  const file = appAppearanceSettingsPath(home),
    marker = join(home, "appearance-settings.initialized");
  const read = (): AppAppearanceSettings => {
    const stored = readHomeFileBounded(home, file, 4096),
      initialized = readHomeFileBounded(home, marker, 64);
    if (stored.problem || initialized.problem)
      throw new AppAppearanceSettingsError(
        503,
        "Private appearance settings are unavailable.",
      );
    if (stored.text === null && initialized.text === null)
      return {
        version: 1,
        revision: 0,
        appearance: { ...DEFAULT_APP_APPEARANCE },
        source: "default",
      };
    if (initialized.text !== MARKER || stored.text === null)
      throw new AppAppearanceSettingsError(
        503,
        "Saved appearance settings are missing or incomplete.",
      );
    try {
      const value = appAppearanceSettingsSchema.parse(JSON.parse(stored.text));
      if (value.source !== "machine") throw Error("Invalid stored provenance");
      return value;
    } catch {
      throw new AppAppearanceSettingsError(
        503,
        "Saved appearance settings are invalid.",
      );
    }
  };
  return {
    read,
    async write(raw: unknown) {
      const parsed = appAppearanceWriteSchema.safeParse(raw);
      if (!parsed.success)
        throw new AppAppearanceSettingsError(
          400,
          "Invalid appearance settings.",
        );
      ensurePrivateHome(home);
      let attempted = false;
      try {
        const result = await withQueueLock(
          join(home, "appearance-settings.lock"),
          async () => {
            const current = read();
            if (current.revision !== parsed.data.expectedRevision)
              throw new AppAppearanceSettingsError(
                409,
                "Appearance settings changed. Check the current values before saving again.",
              );
            const next: AppAppearanceSettings = {
              version: 1,
              revision: current.revision + 1,
              appearance: parsed.data.appearance,
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
          throw new AppAppearanceSettingsError(
            503,
            "Appearance settings are busy or unavailable.",
          );
        return result.value;
      } catch (error) {
        if (attempted)
          throw new AppAppearanceSettingsError(
            504,
            "Appearance settings may have changed. Check current values before saving again.",
          );
        throw error;
      }
    },
  };
}
