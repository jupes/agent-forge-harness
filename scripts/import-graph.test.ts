/**
 * The source scan the import-boundary guards walk.
 *
 * Fixture sources are assembled with `Q`, `S` and `B` for the quotes, so this file
 * holds no text the scan would read as a load: the isolation guard walks
 * every test file, this one included, and an unresolvable relative load
 * throws.
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";
import { importGraph, runtimeSpecifiers } from "./import-graph";

const Q = '"';
const S = "'";
const B = "`";
const REPO = resolve(import.meta.dir, "..");
const temporary: string[] = [];

afterEach(() => {
  for (const dir of temporary.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

/** A scratch tree holding the given files, spelled the way the file system reports it. */
function tree(files: Record<string, string>): string {
  const root = realpathSync.native(
    mkdtempSync(join(tmpdir(), "import graph test ")),
  );
  temporary.push(root);
  for (const [name, source] of Object.entries(files)) {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), source);
  }
  return root;
}

const slashed = (path: string): string => path.replaceAll("\\", "/");
const under = (root: string, names: string[]): string[] =>
  names.map((name) => slashed(join(root, name))).sort();

describe("runtimeSpecifiers", () => {
  test("reads statements, side-effect imports, re-exports, and import, require and import.meta.require calls with one literal argument; skips type-only imports and computed specifiers", () => {
    const source = [
      `import { a } from ${Q}./static${Q};`,
      `import ${Q}./side-effect${Q};`,
      `export { b } from ${Q}./re-export${Q};`,
      `import type { C } from ${Q}./types-only${Q};`,
      `const d = await import(${Q}./dynamic${Q});`,
      `const e = await import(${B}./template${B});`,
      `const f = require(${Q}./required${Q});`,
      `const g = import.meta.require(${S}./meta-required${S});`,
      `const h = await import(${B}./computed-$\{name}${B});`,
      "const i = await import(name);",
      `const j = require(${Q}./prefix${Q} + suffix);`,
    ].join("\n");
    expect(runtimeSpecifiers(source)).toEqual([
      "./static",
      "./side-effect",
      "./re-export",
      "./dynamic",
      "./template",
      "./required",
      "./meta-required",
    ]);
  });
});

describe("importGraph", () => {
  test("follows a relative specifier as written, with .ts added, to a directory's index.ts, and from a .js ending to the .ts file", () => {
    const root = tree({
      "entry.ts": [
        `import ${Q}./plain${Q};`,
        `import ${Q}./folder${Q};`,
        `import ${Q}./compiled.js${Q};`,
        `import ${Q}./exact.mjs${Q};`,
      ].join("\n"),
      "plain.ts": "",
      "folder/index.ts": "",
      "compiled.ts": "",
      "exact.mjs": "",
    });
    expect(importGraph(join(root, "entry.ts")).files.sort()).toEqual(
      under(root, [
        "entry.ts",
        "plain.ts",
        "folder/index.ts",
        "compiled.ts",
        "exact.mjs",
      ]),
    );
  });

  test("a module loaded through require, import.meta.require or a template import is read for its own loads", () => {
    const root = tree({
      "entry.ts": [
        `const a = require(${Q}./by-require${Q});`,
        `const b = import.meta.require(${Q}./by-meta-require${Q});`,
        `const c = await import(${B}./by-template${B});`,
      ].join("\n"),
      "by-require.ts": `import ${Q}./after-require${Q};`,
      "by-meta-require.ts": `import ${Q}./after-meta-require${Q};`,
      "by-template.ts": `import ${Q}./after-template${Q};`,
      "after-require.ts": "",
      "after-meta-require.ts": "",
      "after-template.ts": "",
    });
    expect(importGraph(join(root, "entry.ts")).files.sort()).toEqual(
      under(root, [
        "entry.ts",
        "by-require.ts",
        "by-meta-require.ts",
        "by-template.ts",
        "after-require.ts",
        "after-meta-require.ts",
        "after-template.ts",
      ]),
    );
  });

  test("a tsconfig paths alias is followed from the repo root and is not reported as a package", () => {
    const root = tree({
      "entry.ts": [
        `import ${Q}@docs/bead-builder${Q};`,
        `import ${Q}@/types/hearth${Q};`,
        `import ${Q}@preact/signals${Q};`,
      ].join("\n"),
    });
    const graph = importGraph(join(root, "entry.ts"));
    expect(graph.files).toEqual(
      expect.arrayContaining([
        slashed(join(REPO, "docs", "js", "bead-builder.mjs")),
        slashed(join(REPO, "types", "hearth.ts")),
      ]),
    );
    expect(graph.bare).toEqual(["@preact/signals"]);
  });

  test("a package or built-in is reported as bare and not followed", () => {
    const root = tree({
      "entry.ts": [`import ${Q}node:fs${Q};`, `import ${Q}zod${Q};`].join("\n"),
    });
    const graph = importGraph(join(root, "entry.ts"));
    expect(graph.files).toEqual(under(root, ["entry.ts"]));
    expect(graph.bare.sort()).toEqual(["node:fs", "zod"]);
  });

  test("a relative or alias specifier that reaches no file throws, naming the file and the specifier", () => {
    const relative = tree({ "entry.ts": `import ${Q}./missing${Q};` });
    expect(() => importGraph(join(relative, "entry.ts"))).toThrow(
      `"./missing" reaches no file`,
    );
    const alias = tree({
      "entry.ts": `import ${Q}@/types/no-such-module${Q};`,
    });
    expect(() => importGraph(join(alias, "entry.ts"))).toThrow(
      `"@/types/no-such-module" reaches no file`,
    );
  });

  test("a reached file that is not code is listed but not read for loads", () => {
    const root = tree({
      "entry.ts": `import data from ${Q}./data.json${Q};`,
      // Read as code, this would be a load of a file that does not exist.
      "data.json": `{ ${Q}note${Q}: ${Q}import(${S}./nowhere${S})${Q} }`,
    });
    expect(importGraph(join(root, "entry.ts")).files.sort()).toEqual(
      under(root, ["entry.ts", "data.json"]),
    );
  });
});
