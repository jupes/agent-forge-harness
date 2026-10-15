/**
 * The entry check for every harness CLI: `if (isMain(import.meta))` in place
 * of `if (import.meta.main)` (agent-forge-harness-05hy).
 *
 * Bun's own flag compares spellings. When `bun run` is given a relative path
 * from a working directory spelled with a Windows 8.3 short name
 * (`C:\Users\ERICHS~1\...`, which `os.tmpdir()` returns on some machines), the
 * module's path keeps the short spelling while `Bun.main` has the long one, so
 * `import.meta.main` is false and the CLI exits 0 having done nothing. Every
 * `bun run <script>` in package.json is such a call. This check also accepts
 * a module whose real path is the entry point's real path.
 */

import { realpathSync } from "node:fs";

/** The real path of a file, case-folded where the file system ignores case. */
function realPath(path: string): string | null {
  try {
    const real = realpathSync.native(path);
    return process.platform === "win32" ? real.toLowerCase() : real;
  } catch {
    return null;
  }
}

/**
 * Whether the module `meta` belongs to is the process entry point. `entry` is
 * the entry point's path; it is a parameter so the check can be tested.
 */
export function isMain(
  meta: Pick<ImportMeta, "main" | "path">,
  entry: string = Bun.main,
): boolean {
  if (meta.main) return true;
  const module = realPath(meta.path);
  return module !== null && module === realPath(entry);
}
