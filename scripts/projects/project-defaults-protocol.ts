import { z } from "zod";

const smithName = z
  .string()
  .min(1)
  .max(80)
  .refine((value) => value.trim() === value && !/[\p{Cc}\p{Cs}]/u.test(value));
export const projectDefaultsSchema = z
  .object({
    claudeSessionSmith: smithName.optional(),
    codexSessionSmith: smithName.optional(),
    geminiSessionSmith: smithName.optional(),
    sessionWhere: z.enum(["main", "existing", "new"]).optional(),
    sessionRunAs: z.enum(["chat", "task"]).optional(),
  })
  .strict();
export const PROJECT_DEFAULT_KEYS = [
  "claudeSessionSmith",
  "codexSessionSmith",
  "geminiSessionSmith",
  "sessionWhere",
  "sessionRunAs",
] as const;
export type ProjectDefaultKey = (typeof PROJECT_DEFAULT_KEYS)[number];
export const projectDefaultsChangeSchema = z
  .object({
    claudeSessionSmith: smithName.nullable().optional(),
    codexSessionSmith: smithName.nullable().optional(),
    geminiSessionSmith: smithName.nullable().optional(),
    sessionWhere: z.enum(["main", "existing", "new"]).nullable().optional(),
    sessionRunAs: z.enum(["chat", "task"]).nullable().optional(),
  })
  .strict();
export const projectDefaultsRequestSchema = z
  .object({
    expectedRevision: z
      .number()
      .int()
      .min(0)
      .max(Number.MAX_SAFE_INTEGER - 1),
    defaults: projectDefaultsChangeSchema,
  })
  .strict();
export type ProjectDefaults = z.infer<typeof projectDefaultsSchema>;
export type ProjectDefaultsChange = z.infer<typeof projectDefaultsChangeSchema>;
export function projectDefaultsFrom(record: object): ProjectDefaults {
  return projectDefaultsSchema.parse(
    Object.fromEntries(
      PROJECT_DEFAULT_KEYS.filter((key) => Object.hasOwn(record, key)).map(
        (key) => [key, Reflect.get(record, key)],
      ),
    ),
  );
}
export function validProjectDefaults(record: object): boolean {
  return projectDefaultsSchema.safeParse(
    Object.fromEntries(
      PROJECT_DEFAULT_KEYS.filter((key) => Object.hasOwn(record, key)).map(
        (key) => [key, Reflect.get(record, key)],
      ),
    ),
  ).success;
}
export function sameProjectDefaults(left: object, right: object): boolean {
  return PROJECT_DEFAULT_KEYS.every(
    (key) => Reflect.get(left, key) === Reflect.get(right, key),
  );
}
export function applyProjectDefaults(
  current: object,
  change: ProjectDefaultsChange,
): ProjectDefaults {
  const next: Record<string, unknown> = { ...projectDefaultsFrom(current) };
  // Compatibility: the original empty Claude-only request clears that one default.
  if (!Object.keys(change).length) delete next.claudeSessionSmith;
  for (const key of PROJECT_DEFAULT_KEYS) {
    if (!Object.hasOwn(change, key)) continue;
    const value = change[key];
    if (value === null || value === undefined) delete next[key];
    else next[key] = value;
  }
  return projectDefaultsSchema.parse(next);
}
