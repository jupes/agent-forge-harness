import { z } from "zod";

export const appAppearanceSchema = z
  .object({
    theme: z.enum(["dark", "light", "system"]),
    density: z.enum(["compact", "comfortable"]),
  })
  .strict();
export type AppAppearance = z.infer<typeof appAppearanceSchema>;
export const DEFAULT_APP_APPEARANCE: AppAppearance = {
  theme: "dark",
  density: "compact",
};
export const appAppearanceSettingsSchema = z
  .object({
    version: z.literal(1),
    revision: z
      .number()
      .int()
      .min(0)
      .max(Number.MAX_SAFE_INTEGER - 1),
    appearance: appAppearanceSchema,
    source: z.enum(["default", "machine"]),
  })
  .strict()
  .refine(
    (value) =>
      value.source === "default"
        ? value.revision === 0 &&
          value.appearance.theme === "dark" &&
          value.appearance.density === "compact"
        : value.revision >= 1,
    "Inconsistent appearance provenance.",
  );
export type AppAppearanceSettings = z.infer<typeof appAppearanceSettingsSchema>;
export const appAppearanceWriteSchema = z
  .object({
    expectedRevision: z
      .number()
      .int()
      .min(0)
      .max(Number.MAX_SAFE_INTEGER - 2),
    appearance: appAppearanceSchema,
  })
  .strict();
export function sameAppearance(a: AppAppearance, b: AppAppearance): boolean {
  return a.theme === b.theme && a.density === b.density;
}
export function effectiveAppTheme(
  appearance: AppAppearance,
  systemLight: boolean,
): "dark" | "light" {
  return appearance.theme === "system"
    ? systemLight
      ? "light"
      : "dark"
    : appearance.theme;
}
