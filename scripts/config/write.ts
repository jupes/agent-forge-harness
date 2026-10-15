/**
 * write.ts — `forge:config set`: one value written into one config file.
 *
 * The file is edited, not regenerated: comments, order, a byte-order mark and
 * line endings stay as they were. The editor only edits a file whose every
 * line it understands (blank, comment, `[table]` header, one-segment
 * `key = value`, an array may span lines). Anything else (a dotted key, an
 * inline table, a multi-line string, `[[array]]`) refuses the edit rather
 * than risk writing a file the reader takes differently. An edit is then
 * checked twice before anything is written: the file must parse to what it
 * held with only that key changed, and the loader must accept the result.
 * The write is a temporary file renamed over the target.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "fs";
import { dirname, join } from "path";
import { BENCH_NAMES } from "../../types/hearth";
import { BUILTIN_SMITHS } from "./defaults";
import {
  type ForgeConfig,
  type LoadOptions,
  loadConfig,
  machineConfigFile,
  readConfigText,
} from "./load";

export type ConfigTarget = "user" | "workspace";

export type SetOutcome =
  | {
      ok: true;
      key: string;
      value: unknown;
      file: string;
      created: boolean;
      /** The user file's `execution.env.pass`, which this workspace value now replaces. */
      replacedUserPass?: string[];
    }
  | { ok: false; error: string };

type Kind = "string" | "boolean" | "strings" | "bench";

const SMITH_FIELDS: Record<string, Kind> = {
  provider: "string",
  model: "string",
  effort: "string",
  enabled: "boolean",
  tags: "strings",
};

const BOM = "\uFEFF";
const BARE = /^[A-Za-z0-9_-]+$/;
const EXAMPLE = "agent-forge.toml.example";

/** Every key `set` accepts, for the smiths in `config` (a smith whose name has a `.` cannot be named by a key). */
export function settableKeys(config: ForgeConfig): string[] {
  const keys = ["workflow.default_crew", "execution.env.pass"];
  for (const bench of BENCH_NAMES) keys.push(`benches.${bench}`);
  for (const name of Object.keys(config.smiths)) {
    if (name.includes(".")) continue;
    for (const field of Object.keys(SMITH_FIELDS))
      keys.push(`smiths.${name}.${field}`);
  }
  return keys.sort();
}

interface KeyShape {
  table: string[];
  field: string;
  kind: Kind;
  smith?: string;
}

function keyShape(key: string): KeyShape | string {
  const parts = key.split(".");
  if (parts.length === 2 && key === "workflow.default_crew")
    return { table: ["workflow"], field: "default_crew", kind: "string" };
  if (key === "execution.env.pass")
    return { table: ["execution", "env"], field: "pass", kind: "strings" };
  if (parts.length === 2 && parts[0] === "benches") {
    const bench = parts[1] ?? "";
    return (BENCH_NAMES as readonly string[]).includes(bench)
      ? { table: ["benches"], field: bench, kind: "bench" }
      : `unknown bench "${bench}" (expected ${BENCH_NAMES.join(" | ")})`;
  }
  if (parts.length === 3 && parts[0] === "smiths") {
    const [, smith = "", field = ""] = parts;
    // The loader refuses such a smith, and the edit walks the parsed file by
    // this name: `__proto__` would reach Object.prototype.
    if (smith in Object.prototype)
      return `smiths.${smith}: "${smith}" is a key every object has; name the smith something else`;
    // A key of its own: `constructor` is on every object.
    const kind = Object.hasOwn(SMITH_FIELDS, field)
      ? SMITH_FIELDS[field]
      : undefined;
    if (kind === undefined)
      return `unknown smith field "${field}" (expected ${Object.keys(SMITH_FIELDS).join(" | ")})`;
    return { table: ["smiths", smith], field, kind, smith };
  }
  return `"${key}" is not a key forge:config set writes (see: forge:config keys)`;
}

function listOf(raw: string): string[] {
  return raw.trim() === "" ? [] : raw.split(",").map((item) => item.trim());
}

/** The value for `kind`, from what was typed, or why it is not one. */
function typedValue(kind: Kind, raw: string): { value: unknown } | string {
  if (kind === "string") return { value: raw };
  if (kind === "boolean")
    return raw === "true" || raw === "false"
      ? { value: raw === "true" }
      : `expected true or false, got "${raw}"`;
  const items = listOf(raw);
  if (items.some((item) => item === ""))
    return "an empty item in the list (items are separated by commas)";
  if (kind === "bench" && items.length === 0)
    return 'a bench needs at least one "smith:weight" entry';
  return { value: items };
}

/** A TOML literal for a value of one of the shapes above. */
function literal(value: unknown): string {
  if (Array.isArray(value))
    return `[${value.map((item) => JSON.stringify(String(item))).join(", ")}]`;
  if (typeof value === "boolean") return String(value);
  return JSON.stringify(String(value));
}

function segment(name: string): string {
  return BARE.test(name) ? name : JSON.stringify(name);
}

// ── The scanner ─────────────────────────────────────────────────────────────

interface Header {
  path: string[];
  /** Offset just past the header line (after its line ending, or at the end). */
  lineEnd: number;
}

interface Entry {
  table: string[];
  key: string;
  valueStart: number;
  valueEnd: number;
  /** Offset just past the line the value ends on. */
  lineEnd: number;
}

interface Scan {
  headers: Header[];
  entries: Entry[];
}

class Refusal extends Error {}

/** The headers and `key = value` entries of a document the editor owns, or a refusal naming the line. */
function scan(text: string): Scan {
  const headers: Header[] = [];
  const entries: Entry[] = [];
  let table: string[] = [];
  let i = 0;

  const lineOf = (at: number): number => text.slice(0, at).split("\n").length;
  const refuse = (at: number, what: string): never => {
    throw new Refusal(
      `line ${lineOf(at)}: ${what}, which forge:config set does not edit; change it by hand`,
    );
  };
  const spaces = (): void => {
    while (text[i] === " " || text[i] === "\t") i++;
  };
  const comment = (): void => {
    if (text[i] === "#") while (i < text.length && text[i] !== "\n") i++;
  };
  /** Past the end of the line: only spaces and a comment may remain on it. */
  const endOfLine = (): number => {
    spaces();
    comment();
    if (text[i] === "\r" && text[i + 1] === "\n") i++;
    if (i < text.length && text[i] !== "\n")
      refuse(i, "more than one value on a line");
    if (i < text.length) i++;
    return i;
  };
  /** Past a one-line string; its text as written, quotes included (values are never decoded). */
  const quoted = (): string => {
    const quote = text[i];
    if (text.startsWith(quote === '"' ? '"""' : "'''", i))
      refuse(i, "a multi-line string");
    const start = i;
    i++;
    while (i < text.length && text[i] !== quote) {
      if (text[i] === "\n") refuse(start, "an unterminated string");
      if (quote === '"' && text[i] === "\\") i++;
      i++;
    }
    if (i >= text.length) refuse(start, "an unterminated string");
    i++;
    return text.slice(start, i);
  };
  const keySegment = (): string => {
    if (text[i] === "'") return quoted().slice(1, -1);
    if (text[i] === '"') {
      const start = i;
      const raw = quoted();
      // A key's escapes are JSON's, except the few TOML adds; those are not read here.
      try {
        return JSON.parse(raw) as string;
      } catch {
        return refuse(start, "a key forge:config set does not read");
      }
    }
    const start = i;
    while (i < text.length && /[A-Za-z0-9_-]/.test(text[i] ?? "")) i++;
    if (i === start)
      refuse(start, "a line that is not a key, a table or a comment");
    return text.slice(start, i);
  };
  /** Inside an array: spaces, line endings and comments. */
  const gaps = (): void => {
    for (;;) {
      spaces();
      comment();
      if (text[i] === "\r" || text[i] === "\n") i++;
      else return;
    }
  };
  const value = (): void => {
    const c = text[i];
    if (c === '"' || c === "'") return void quoted();
    if (c === "{") refuse(i, "an inline table");
    if (c === "[") {
      i++;
      gaps();
      while (text[i] !== "]") {
        if (i >= text.length) refuse(i, "an unterminated array");
        value();
        gaps();
        if (text[i] === ",") {
          i++;
          gaps();
        } else if (text[i] !== "]")
          refuse(i, "an array that is not a list of values");
      }
      i++;
      return;
    }
    const start = i;
    while (i < text.length && /[A-Za-z0-9_+\-.:]/.test(text[i] ?? "")) i++;
    if (i === start) refuse(start, "a value forge:config set does not read");
  };

  while (i < text.length) {
    const lineStart = i;
    spaces();
    const c = text[i];
    if (c === "\n" || c === "\r" || c === "#" || c === undefined) {
      endOfLine();
      continue;
    }
    if (c === "[") {
      if (text[i + 1] === "[") refuse(i, "an array of tables ([[…]])");
      i++;
      const path: string[] = [];
      for (;;) {
        spaces();
        path.push(keySegment());
        spaces();
        if (text[i] === ".") {
          i++;
          continue;
        }
        if (text[i] === "]") break;
        refuse(lineStart, "a table header forge:config set does not read");
      }
      i++;
      table = path;
      headers.push({ path, lineEnd: endOfLine() });
      continue;
    }
    const key = keySegment();
    spaces();
    if (text[i] === ".") refuse(lineStart, "a dotted key");
    if (text[i] !== "=") refuse(lineStart, "a line that is not a key = value");
    i++;
    spaces();
    const valueStart = i;
    value();
    const valueEnd = i;
    entries.push({ table, key, valueStart, valueEnd, lineEnd: endOfLine() });
  }
  return { headers, entries };
}

// ── Reading what the files hold ─────────────────────────────────────────────

type Table = Record<string, unknown>;

function isTable(value: unknown): value is Table {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parse(text: string): Table {
  const parsed = Bun.TOML.parse(text.startsWith(BOM) ? text.slice(1) : text);
  return isTable(parsed) ? parsed : {};
}

/** The parsed file, or an empty table when it is absent or does not parse (the loader reports that). */
function parsedFile(file: string): Table {
  if (!existsSync(file)) return {};
  try {
    return parse(readConfigText(file));
  } catch {
    return {};
  }
}

function at(doc: Table, path: readonly string[]): unknown {
  let node: unknown = doc;
  for (const part of path) {
    if (!isTable(node)) return undefined;
    node = node[part];
  }
  return node;
}

function smithsOf(doc: Table): string[] {
  const smiths = doc["smiths"];
  return isTable(smiths) ? Object.keys(smiths) : [];
}

function withValue(doc: Table, path: readonly string[], value: unknown): Table {
  const copy = structuredClone(doc);
  let node: Table = copy;
  for (const part of path.slice(0, -1)) {
    const next = node[part];
    if (!isTable(next)) node[part] = {};
    node = node[part] as Table;
  }
  node[path[path.length - 1] ?? ""] = value;
  return copy;
}

const samePath = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((part, index) => part === b[index]);

// ── set ─────────────────────────────────────────────────────────────────────

/** The text with `key = value` placed, or a refusal. */
function edited(
  text: string,
  shape: KeyShape,
  value: unknown,
  old: Table,
): string {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const { headers, entries } = scan(text);
  const path = [...shape.table, shape.field];
  const line = `${segment(shape.field)} = ${literal(value)}`;

  const owned = headers.filter((header) => samePath(header.path, shape.table));
  if (owned.length > 1)
    throw new Refusal(
      `[${shape.table.join(".")}] appears more than once; change it by hand`,
    );
  const entry = entries.find(
    (candidate) =>
      samePath(candidate.table, shape.table) && candidate.key === shape.field,
  );
  if (entry !== undefined)
    return (
      text.slice(0, entry.valueStart) +
      literal(value) +
      text.slice(entry.valueEnd)
    );
  if (at(old, path) !== undefined)
    throw new Refusal(
      `${path.join(".")} is set in a way forge:config set cannot find; change it by hand`,
    );

  const tableValue = at(old, shape.table);
  if (tableValue !== undefined && !isTable(tableValue))
    throw new Refusal(
      `${shape.table.join(".")} holds a value, not a table; change it by hand`,
    );
  const header = owned[0];
  if (header !== undefined) {
    const last = entries
      .filter((candidate) => samePath(candidate.table, shape.table))
      .reduce(
        (end, candidate) => Math.max(end, candidate.lineEnd),
        header.lineEnd,
      );
    const before = text.slice(0, last);
    const joint = before === "" || before.endsWith("\n") ? "" : eol;
    return `${before}${joint}${line}${eol}${text.slice(last)}`;
  }
  const lead = text === "" ? "" : text.endsWith("\n") ? eol : `${eol}${eol}`;
  return `${text}${lead}[${shape.table.map(segment).join(".")}]${eol}${line}${eol}`;
}

/** Write one value into the user or the workspace config file. Nothing is written on a refusal. */
export function setConfigValue(request: {
  key: string;
  raw: string;
  target: ConfigTarget;
  options: LoadOptions;
}): SetOutcome {
  const { key, raw, target, options } = request;
  const userFile = machineConfigFile(options);
  const workspaceFile = join(options.harnessRoot, "agent-forge.toml");
  const file = target === "user" ? userFile : workspaceFile;
  const fail = (error: string): SetOutcome => ({ ok: false, error });

  const shape = keyShape(key);
  if (typeof shape === "string") return fail(shape);
  const typed = typedValue(shape.kind, raw);
  if (typeof typed === "string") return fail(`${key}: ${typed}`);
  const { value } = typed;

  const userDoc = parsedFile(userFile);
  const workspaceDoc = parsedFile(workspaceFile);
  const workspaceExists = existsSync(workspaceFile);

  if (shape.smith !== undefined) {
    const known = new Set([
      ...Object.keys(BUILTIN_SMITHS),
      ...smithsOf(userDoc),
      ...(target === "workspace" ? smithsOf(workspaceDoc) : []),
    ]);
    if (!known.has(shape.smith))
      return fail(
        target === "user" && smithsOf(workspaceDoc).includes(shape.smith)
          ? `smith "${shape.smith}" is defined only in the workspace file; set it with --workspace`
          : `unknown smith "${shape.smith}": a new smith needs provider, model and effort together, so add its table by hand (see ${EXAMPLE})`,
      );
  }

  const userPass = at(userDoc, ["execution", "env", "pass"]);
  const userPassList = Array.isArray(userPass) ? userPass.map(String) : [];
  let replacedUserPass: string[] | undefined;
  if (key === "execution.env.pass" && target === "user" && workspaceExists)
    return fail(
      `execution.env.pass in ${userFile} would not take effect: ${workspaceFile} exists, and a workspace file never inherits it. Set it with --workspace`,
    );
  if (target === "workspace" && !workspaceExists && userPassList.length > 0) {
    if (key !== "execution.env.pass")
      return fail(
        `creating ${workspaceFile} would stop execution.env.pass from ${userFile} (${userPassList.join(", ")}) applying: a workspace file never inherits it. Keep it there first: bun run forge:config set execution.env.pass "${userPassList.join(",")}" --workspace`,
      );
    replacedUserPass = userPassList;
  }

  const existed = existsSync(file);
  let original = "";
  try {
    if (existed) original = readConfigText(file);
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
  const bom = original.startsWith(BOM);
  const body = bom ? original.slice(1) : original;

  let oldDoc: Table;
  try {
    oldDoc = parse(body);
  } catch (error) {
    return fail(
      `${file} does not parse (${error instanceof Error ? error.message : String(error)}); change it by hand`,
    );
  }
  let next: string;
  try {
    next = edited(body, shape, value, oldDoc);
  } catch (error) {
    if (error instanceof Refusal) return fail(`${file}: ${error.message}`);
    throw error;
  }

  // The edit must change that key and nothing else, and the result must load.
  const path = [...shape.table, shape.field];
  let newDoc: Table;
  try {
    newDoc = parse(next);
  } catch {
    return fail(`${file}: the edit would not parse; change it by hand`);
  }
  if (!Bun.deepEquals(newDoc, withValue(oldDoc, path, value), true))
    return fail(
      `${file}: the edit would change more than ${key}; change it by hand`,
    );
  try {
    loadConfig({
      ...options,
      contents: { ...options.contents, [target]: next },
    });
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }

  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  try {
    writeFileSync(temporary, bom ? `${BOM}${next}` : next);
    renameSync(temporary, file);
  } catch (error) {
    rmSync(temporary, { force: true });
    return fail(
      `${file}: could not be written (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  return {
    ok: true,
    key,
    value,
    file,
    created: !existed,
    ...(replacedUserPass !== undefined ? { replacedUserPass } : {}),
  };
}
