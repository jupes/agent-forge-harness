/**
 * A source scan of what a module loads: the local files and the bare
 * specifiers reachable from an entry.
 *
 * Used by the guards that hold an import boundary (what Vite may load, which
 * test files can start a process). It reads text, not a parse tree, and errs
 * toward reporting more: an import that only brings in types but is not
 * written `import type` counts as loaded, and so does anything in a comment or
 * a string that is shaped like an import.
 *
 * What it reads as a load: an `import` or `export … from` statement, a bare
 * `import "x"`, and a call with one literal argument — `import("x")`,
 * ``import(`x`)`` with no `${}` in it, `require("x")` and
 * `import.meta.require("x")`. A relative specifier is followed to a file as
 * written, with `.ts` or `.tsx` added, as `index.ts` inside it, or with a `.js`
 * ending read as `.ts` or `.tsx`; a specifier that matches a `paths` alias in
 * the repo's `tsconfig.json` is followed the same way from the repo root. A
 * relative or alias specifier that reaches no file throws, so a form the scan
 * misreads fails a guard instead of quietly dropping a module from it. That
 * includes text in a string: a test that holds module source with a relative
 * import in it assembles that line (`scripts/hearth/mcp.test.ts`,
 * `scripts/import-graph.test.ts`), since the isolation guard walks every test
 * file. A file that is not `.ts`, `.tsx`, `.mjs` or `.js` (JSON, CSS) is
 * reached but not read.
 *
 * What it cannot see: a specifier that is computed (a variable, a template
 * with `${}`, a concatenation), an alias only a bundler defines (Vite's
 * `resolve.alias`) unless `tsconfig.json` names it too, and anything inside a
 * package.
 */

import { existsSync, readFileSync, statSync } from "fs";
import { dirname, join, resolve } from "path";

export interface ImportGraph {
  /** Every local file reached, the entries included, with forward slashes. */
  files: string[];
  /** Every specifier that is neither relative nor an alias: packages and built-ins. */
  bare: string[];
}

const STATEMENT =
  /^\s*(?:import|export)\s+(?!type\b)(?:[^"';]*?\sfrom\s+)?["']([^"']+)["']/gm;
/** `import(…)`, `require(…)` and `import.meta.require(…)` with one literal argument. */
const CALL =
  /\b(?:import|require)\(\s*(?:"([^"]+)"|'([^']+)'|`([^`$]+)`)\s*\)/g;

/** Module specifiers a file loads at runtime: type-only imports are skipped. */
export function runtimeSpecifiers(source: string): string[] {
  const found: string[] = [];
  for (const match of source.matchAll(STATEMENT))
    if (match[1] !== undefined) found.push(match[1]);
  for (const match of source.matchAll(CALL)) {
    const specifier = match[1] ?? match[2] ?? match[3];
    if (specifier !== undefined) found.push(specifier);
  }
  return found;
}

const REPO = resolve(import.meta.dir, "..");
const READ = /\.(?:tsx?|mjs|js)$/;

/** The `paths` aliases in the repo's `tsconfig.json`: pattern to first target. */
function tsconfigAliases(): ReadonlyArray<[string, string]> {
  const config = JSON.parse(
    readFileSync(join(REPO, "tsconfig.json"), "utf8"),
  ) as { compilerOptions?: { paths?: Record<string, string[]> } };
  return Object.entries(config.compilerOptions?.paths ?? {}).flatMap(
    ([pattern, targets]): Array<[string, string]> =>
      targets[0] === undefined ? [] : [[pattern, targets[0]]],
  );
}

let aliases: ReadonlyArray<[string, string]> | undefined;

/** The path an alias specifier stands for, or null when no alias matches. */
function aliasTarget(specifier: string): string | null {
  aliases ??= tsconfigAliases();
  for (const [pattern, target] of aliases) {
    if (pattern.endsWith("*")) {
      const prefix = pattern.slice(0, -1);
      if (specifier.startsWith(prefix))
        return resolve(
          REPO,
          target.replace("*", specifier.slice(prefix.length)),
        );
    } else if (specifier === pattern) return resolve(REPO, target);
  }
  return null;
}

function isFile(path: string): boolean {
  return existsSync(path) && statSync(path).isFile();
}

/** The file a path names, the way the scan follows a relative specifier; null when none. */
function resolveFile(base: string): string | null {
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    join(base, "index.ts"),
  ];
  if (base.endsWith(".js"))
    candidates.push(`${base.slice(0, -3)}.ts`, `${base.slice(0, -3)}.tsx`);
  return candidates.find(isFile) ?? null;
}

export function importGraph(...entries: string[]): ImportGraph {
  const files = new Set<string>(entries.map((entry) => resolve(entry)));
  const bare = new Set<string>();
  const queue = [...files];
  for (let file = queue.pop(); file !== undefined; file = queue.pop()) {
    if (!READ.test(file)) continue;
    for (const specifier of runtimeSpecifiers(readFileSync(file, "utf8"))) {
      const base = specifier.startsWith(".")
        ? resolve(dirname(file), specifier)
        : aliasTarget(specifier);
      if (base === null) {
        bare.add(specifier);
        continue;
      }
      const next = resolveFile(base);
      if (next === null)
        throw new Error(`${file}: "${specifier}" reaches no file`);
      if (!files.has(next)) {
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
