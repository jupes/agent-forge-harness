/**
 * A source scan of what a module loads: the local files and the bare
 * specifiers reachable from an entry through static and literal dynamic
 * imports.
 *
 * Used by the guards that hold an import boundary (what Vite may load, which
 * test files can start a process). It reads text, not a parse tree, and errs
 * toward reporting more: an import that only brings in types but is not
 * written `import type` counts as loaded. What it cannot see: a dynamic import
 * whose specifier is computed, and anything inside a package.
 */

import { existsSync, readFileSync } from "fs";
import { dirname, join, resolve } from "path";

export interface ImportGraph {
  /** Every local file reached, the entries included, with forward slashes. */
  files: string[];
  /** Every specifier that is not a relative path: packages and built-ins. */
  bare: string[];
}

/** Module specifiers a file loads at runtime: type-only imports are skipped. */
export function runtimeSpecifiers(source: string): string[] {
  const found: string[] = [];
  const statement =
    /^\s*(?:import|export)\s+(?!type\b)(?:[^"';]*?\sfrom\s+)?["']([^"']+)["']/gm;
  const dynamic = /\bimport\(\s*["']([^"']+)["']\s*\)/g;
  for (const pattern of [statement, dynamic])
    for (const match of source.matchAll(pattern))
      if (match[1] !== undefined) found.push(match[1]);
  return found;
}

function resolveLocal(from: string, specifier: string): string | null {
  const base = resolve(dirname(from), specifier);
  for (const candidate of [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    join(base, "index.ts"),
  ])
    if (/\.(?:tsx?|mjs)$/.test(candidate) && existsSync(candidate))
      return candidate;
  return null;
}

export function importGraph(...entries: string[]): ImportGraph {
  const files = new Set<string>(entries.map((entry) => resolve(entry)));
  const bare = new Set<string>();
  const queue = [...files];
  for (let file = queue.pop(); file !== undefined; file = queue.pop()) {
    for (const specifier of runtimeSpecifiers(readFileSync(file, "utf8"))) {
      if (!specifier.startsWith(".")) {
        bare.add(specifier);
        continue;
      }
      const next = resolveLocal(file, specifier);
      if (next !== null && !files.has(next)) {
        files.add(next);
        queue.push(next);
      }
    }
  }
  return {
    files: [...files].map((file) => file.replaceAll("\\", "/")),
    bare: [...bare],
  };
}
