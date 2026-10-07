import { BASE_ENV_ALLOWLIST } from "../config/defaults";

/**
 * The environment a spawned executor receives: the base set it needs to start
 * plus the configured `pass` list, and nothing else. Names match
 * case-insensitively (Windows reports `Path`), and the parent's casing is kept.
 */
export function buildChildEnv(
  parent: Record<string, string | undefined>,
  pass: readonly string[],
): Record<string, string> {
  const allowed = new Set(
    [...BASE_ENV_ALLOWLIST, ...pass].map((name) => name.toLowerCase()),
  );
  const child: Record<string, string> = {};
  for (const [name, value] of Object.entries(parent)) {
    if (value !== undefined && allowed.has(name.toLowerCase())) {
      child[name] = value;
    }
  }
  return child;
}
