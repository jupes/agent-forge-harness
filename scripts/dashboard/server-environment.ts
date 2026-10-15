/**
 * Environment files for the hearth's server-side services (the council's
 * provider credentials), read without Vite.
 *
 * The hearth used Vite's `loadEnv` for this. With Vite in its graph,
 * `bun build --compile` of the hearth stopped at an optional dependency of
 * Vite it could not resolve (`lightningcss`). The hearth is to be compiled as
 * a sidecar, so this module reads the same files the same way with built-ins
 * only. What it keeps from `loadEnv`:
 *
 * - The files, in order: `.env`, `.env.local`, `.env.<mode>`,
 *   `.env.<mode>.local` in `root`. A later file wins over an earlier one, and
 *   only regular files are read.
 * - The line format: `KEY=value` or `KEY: value`, an optional `export ` before
 *   the key, `#` comments, values in single, double or back quotes (which may
 *   span lines), `\n` and `\r` turned into line breaks inside double quotes
 *   only, and an unquoted value trimmed and cut at its first `#`.
 * - Expansion: `$NAME` and `${NAME}` take the launching process's value, else
 *   a file's, else nothing. `${NAME:-default}` and `${NAME-default}` give the
 *   default when NAME is unset or empty. `${NAME:+alternate}` and
 *   `${NAME+alternate}` give the alternate only when it is set and not
 *   empty. `\$` is a literal dollar. A key the process sets keeps the
 *   process's value.
 *
 * What it does not keep:
 * - `loadEnv` read this process's variables; this reads the
 *   `processEnvironment` it is handed (the same set in the hearth).
 * - It writes nothing back to `process.env`.
 * - A reference with no operator is read whole. `loadEnv` split it at the
 *   text `null`, so it read `${nullable}` as the default `able`.
 */

import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export type DashboardServerEnvironmentOptions = {
  mode: string;
  root: string;
  processEnvironment?: Record<string, string | undefined>;
};

type Variables = Record<string, string | undefined>;

/**
 * Load repository-local environment files for server-only dashboard services.
 * Values already present in the launching process take precedence.
 */
export function loadDashboardServerEnvironment({
  mode,
  root,
  processEnvironment = process.env,
}: DashboardServerEnvironmentOptions): Record<string, string | undefined> {
  return {
    ...expandEnvironment(readEnvironmentFiles(mode, root), processEnvironment),
    ...processEnvironment,
  };
}

/** The four files' assignments merged, a later file's value winning; a key keeps the place it was first seen. */
function readEnvironmentFiles(
  mode: string,
  root: string,
): Record<string, string> {
  if (mode === "local")
    throw new Error(
      '"local" cannot be used as a mode name because it conflicts with the .local postfix for .env files.',
    );
  const merged: Record<string, string> = {};
  for (const name of [
    ".env",
    ".env.local",
    `.env.${mode}`,
    `.env.${mode}.local`,
  ]) {
    const file = join(root, name);
    let isFile = false;
    try {
      isFile = statSync(file).isFile();
    } catch {
      // Absent: nothing to read.
    }
    if (!isFile) continue;
    for (const [key, value] of parseEnvironmentFile(readFileSync(file, "utf8")))
      merged[key] = value;
  }
  return merged;
}

/**
 * One assignment, from the start of a line: leading space (blank lines too),
 * an optional `export`, the key, `=` or a colon and a space, then a quoted
 * value or a bare one up to a `#` or the line's end, then an optional comment.
 */
const ASSIGNMENT = new RegExp(
  [
    String.raw`^\s*(?:export\s+)?`,
    String.raw`([\w.-]+)`,
    String.raw`(?:\s*=\s*?|:\s+?)`,
    "(",
    [
      String.raw`\s*'(?:\\'|[^'])*'`,
      String.raw`\s*"(?:\\"|[^"])*"`,
      String.raw`\s*\x60(?:\\\x60|[^\x60])*\x60`,
      String.raw`[^#\r\n]+`,
    ].join("|"),
    ")?",
    String.raw`\s*(?:#.*)?$`,
  ].join(""),
  "gm",
);

/** The assignments of one file, in order; a key given twice appears twice. */
function parseEnvironmentFile(text: string): Array<[string, string]> {
  const lines = text.replace(/\r\n?/g, "\n");
  const found: Array<[string, string]> = [];
  for (const match of lines.matchAll(ASSIGNMENT)) {
    const key = match[1];
    if (key === undefined) continue;
    const raw = (match[2] ?? "").trim();
    const quote = raw[0];
    let value = /^(['"`])([\s\S]*)\1$/.test(raw) ? raw.slice(1, -1) : raw;
    if (quote === '"')
      value = value.replaceAll("\\n", "\n").replaceAll("\\r", "\r");
    found.push([key, value]);
  }
  return found;
}

/** `$NAME` or `${expression}`, not after a backslash. */
const REFERENCE = /(?<!\\)\${([^{}]+)}|(?<!\\)\$([A-Za-z_][A-Za-z0-9_]*)/g;
/** The first operator in a braced expression. */
const OPERATOR = /(:\+|\+|:-|-)/;

/**
 * The files' values with references expanded, in the order the keys were
 * first seen. A key the process sets to a different, non-empty value takes
 * the process's value unexpanded. A key expanded earlier is seen expanded by
 * a later one.
 */
function expandEnvironment(
  parsed: Record<string, string>,
  processEnvironment: Variables,
): Record<string, string> {
  const values = { ...parsed };
  for (const key of Object.keys(values)) {
    const own = values[key] ?? "";
    const fromProcess = processEnvironment[key];
    const value =
      fromProcess && fromProcess !== own
        ? fromProcess
        : expandValue(own, processEnvironment, values);
    values[key] = value.replaceAll("\\$", "$");
  }
  return values;
}

function expandValue(
  value: string,
  processEnvironment: Variables,
  values: Record<string, string>,
): string {
  // The process's value wins over a file's.
  const known: Variables = { ...values, ...processEnvironment };
  let result = value;
  // Every text the value has passed through: a reference that would bring one back is a loop.
  const seen = new Set<string>();
  REFERENCE.lastIndex = 0;
  for (
    let match = REFERENCE.exec(result);
    match !== null;
    match = REFERENCE.exec(result)
  ) {
    seen.add(result);
    const [template, braced, bare] = match;
    const expression = braced ?? bare ?? "";
    const operator = OPERATOR.exec(expression)?.[0];
    const [name = "", ...rest] =
      operator === undefined ? [expression] : expression.split(operator);
    const tail = operator === undefined ? "" : rest.join(operator);
    let replacement: string;
    if (operator === ":+" || operator === "+") {
      replacement = known[name] ? tail : "";
    } else {
      const found = known[name];
      replacement = found ? (seen.has(found) ? tail : found) : tail;
    }
    result = result.replace(template, replacement);
    if (result === values[name]) break;
    REFERENCE.lastIndex = 0;
  }
  return result;
}
