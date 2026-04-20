#!/usr/bin/env bun
/**
 * Validate molecule JSON files against the v1 schema.
 *
 * Usage:
 *   bun run molecules:check                      # all .json under .claude/molecules
 *   bun run molecules:check some/path.json ...   # specific files
 *
 * Emits `{ ok, data: [ { path, ok, error? } ], error }` and exits non-zero on any failure.
 */

import { readFileSync, readdirSync, statSync } from "fs";
import { join, relative } from "path";
import { parseMoleculeJson } from "./parse";

const MOL_DIR = join(process.cwd(), ".claude", "molecules");

function listDefaultFiles(): string[] {
  let entries: string[];
  try {
    entries = readdirSync(MOL_DIR);
  } catch {
    return [];
  }
  return entries
    .filter((name) => name.endsWith(".json"))
    .map((name) => join(MOL_DIR, name))
    .filter((p) => {
      try {
        return statSync(p).isFile();
      } catch {
        return false;
      }
    });
}

type Result = { path: string; ok: boolean; error?: string };

function checkFile(abs: string): Result {
  let text: string;
  try {
    text = readFileSync(abs, "utf8");
  } catch (e) {
    return { path: relative(process.cwd(), abs), ok: false, error: (e as Error).message };
  }
  const parsed = parseMoleculeJson(text);
  if (parsed.ok) {
    return { path: relative(process.cwd(), abs), ok: true };
  }
  return { path: relative(process.cwd(), abs), ok: false, error: parsed.error };
}

function main(): void {
  const args = process.argv.slice(2);
  const files = args.length > 0 ? args.map((p) => (p.startsWith(".") || p.includes(":") ? p : p)) : listDefaultFiles();
  if (files.length === 0) {
    console.log(
      JSON.stringify(
        { ok: true, data: [], error: null, note: "no molecule files found in .claude/molecules/" },
        null,
        2,
      ),
    );
    return;
  }
  const results = files.map((f) => checkFile(f));
  const allOk = results.every((r) => r.ok);
  console.log(
    JSON.stringify(
      {
        ok: allOk,
        data: results,
        error: allOk ? null : `${results.filter((r) => !r.ok).length} molecule(s) failed validation`,
      },
      null,
      2,
    ),
  );
  if (!allOk) process.exit(1);
}

if (import.meta.main) {
  main();
}
