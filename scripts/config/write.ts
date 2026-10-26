/**
 * write.ts — `forge:config set` and pure complete-Smith create candidates.
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

import { createHash } from "node:crypto";
import { BENCH_NAMES, type Smith } from "../../types/hearth";
import type {
  SmithConfigEditFields,
  SmithConfigEditPreviewRequest,
  SmithConfigEditReview,
  SmithConfigEditTargetBefore,
} from "../../types/smith-config-edit";
import { validateSmith } from "../hearth/validate";
import { BUILTIN_SHIFT, BUILTIN_SMITHS } from "./defaults";
import {
  decodeConfigText,
  type ForgeConfig,
  type LoadedConfig,
  type LoadOptions,
  loadConfigFromByteContents,
  loadConfigFromContents,
  SHIFT_KEYS,
  type ShiftKey,
} from "./load";
import { smithConfigEditPreviewRequestSchema } from "./smith-edit-protocol";
import {
  type ConfigWriteTransaction,
  type PreparedConfigTransaction,
  prepareConfigTransaction,
  withConfigTransaction,
} from "./transaction";

export type ConfigTarget = "user" | "workspace";

/** Captured raw UTF-8; null means absent, including when its parent does not exist. */
export interface ConfigByteSource {
  /** Trusted diagnostic/provenance label; the candidate never dereferences it. */
  file: string;
  bytes: Uint8Array | null;
}

export interface ConfigSourceFingerprint {
  file: string;
  sha256: string | null;
  byteLength: number | null;
}

export interface SmithCreateCandidate {
  target: ConfigTarget;
  file: string;
  created: boolean;
  smith: Smith;
  /** Owned candidate copy, including any original BOM; no file has been written. */
  bytes: Uint8Array;
  sha256: string;
  sources: Record<ConfigTarget, ConfigSourceFingerprint>;
  effective: LoadedConfig;
}

export type SmithCreateCandidateOutcome =
  | { ok: true; value: SmithCreateCandidate }
  | { ok: false; error: string };

export interface SmithEditCandidate {
  target: ConfigTarget;
  file: string;
  created: boolean;
  smith: Smith;
  bytes: Uint8Array;
  sha256: string;
  sources: Record<ConfigTarget, ConfigSourceFingerprint>;
  review: SmithConfigEditReview;
}

export type SmithEditCandidateOutcome =
  | { ok: true; value: SmithEditCandidate }
  | { ok: false; error: string };

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

type Kind = "string" | "boolean" | "number" | "strings" | "bench";

const SMITH_FIELDS: Record<string, Kind> = {
  provider: "string",
  model: "string",
  effort: "string",
  enabled: "boolean",
  tags: "strings",
};

const BOM = "\uFEFF";
const BARE = /^[A-Za-z0-9_-]+$/;
/** A number as typed for a `[shift]` key: digits, an optional fraction, an optional minus (the loader says what is out of bounds). */
const NUMBER = /^-?\d{1,9}(\.\d{1,9})?$/;
const EXAMPLE = "agent-forge.toml.example";

/** Every key `set` accepts, for the smiths in `config` (a smith whose name has a `.` cannot be named by a key). */
export function settableKeys(config: ForgeConfig): string[] {
  const keys = ["workflow.default_crew", "execution.env.pass"];
  for (const bench of BENCH_NAMES) keys.push(`benches.${bench}`);
  for (const key of SHIFT_KEYS) keys.push(`shift.${key}`);
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
  if (parts.length === 2 && parts[0] === "shift") {
    const field = parts[1] ?? "";
    // Looked up in the list, not as a property: `constructor` is on every object.
    if (!(SHIFT_KEYS as readonly string[]).includes(field))
      return `unknown shift key "${field}" (expected ${SHIFT_KEYS.join(" | ")})`;
    // `for` is a duration as written ("90m"); the others are numbers.
    const kind =
      typeof BUILTIN_SHIFT[field as ShiftKey] === "number"
        ? "number"
        : "string";
    return { table: ["shift"], field, kind };
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
  if (kind === "number")
    return NUMBER.test(raw)
      ? { value: Number(raw) }
      : `expected a number such as 3 or 0.85, got "${raw}"`;
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
  if (typeof value === "boolean" || typeof value === "number")
    return String(value);
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
function parsedSource(source: ConfigByteSource): Table {
  if (source.bytes === null) return {};
  try {
    return parse(decodeConfigText(source.file, source.bytes));
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

/**
 * Build one new Smith table from two explicit byte snapshots and an explicit env.
 * Only the selected layer must fit the editor's scanner dialect. Both snapshots
 * must be strict UTF-8 and the complete effective config must load. The result
 * is a proposal, not a write/lock receipt or certification of executor support.
 */
export function buildSmithCreateCandidate(request: {
  target: ConfigTarget;
  smith: unknown;
  sources: Record<ConfigTarget, ConfigByteSource>;
  env: Readonly<Record<string, string | undefined>>;
}): SmithCreateCandidateOutcome {
  if (request.target !== "user" && request.target !== "workspace")
    return { ok: false, error: "expected user or workspace target" };
  const smithFields = ["name", ...Object.keys(SMITH_FIELDS)];
  if (
    !isTable(request.smith) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(request.smith)) ||
    Reflect.ownKeys(request.smith).length !== smithFields.length ||
    smithFields.some((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(request.smith, key);
      return descriptor === undefined || !("value" in descriptor);
    })
  )
    return {
      ok: false,
      error: `a complete Smith needs exactly ${smithFields.join(", ")}`,
    };
  const checked = validateSmith(request.smith);
  if (!checked.ok) return checked;
  const { name, provider, model, effort, enabled, tags } = checked.value;
  if (name in Object.prototype)
    return {
      ok: false,
      error: `smiths.${name}: "${name}" is a key every object has; name the smith something else`,
    };
  const smith: Smith = {
    name,
    provider,
    model,
    effort,
    enabled,
    tags: [...tags],
  };
  try {
    const user = capturedSource(request.sources.user);
    const workspace = capturedSource(request.sources.workspace);
    const texts = { user: user.source, workspace: workspace.source };
    const docs = { user: user.doc, workspace: workspace.doc };
    if (
      [
        ...Object.keys(BUILTIN_SMITHS),
        ...smithsOf(docs.user),
        ...smithsOf(docs.workspace),
      ].includes(name)
    )
      throw new Refusal(
        `smith "${name}" already exists in builtin, user or workspace config; create cannot override it`,
      );
    const userPass = at(docs.user, ["execution", "env", "pass"]);
    if (
      request.target === "workspace" &&
      texts.workspace.text === null &&
      Array.isArray(userPass) &&
      userPass.length > 0
    )
      throw new Refusal(
        firstWorkspacePassRefusal(
          texts.user.file,
          texts.workspace.file,
          userPass.map(String),
        ),
      );
    const source = texts[request.target];
    const original = source.text ?? "";
    const bom = original.startsWith(BOM) ? BOM : "";
    const body = original.slice(bom.length);
    const old = docs[request.target];
    if (old.smiths !== undefined && !isTable(old.smiths))
      throw new Refusal(
        `${source.file}: smiths holds a value, not a table; change it by hand`,
      );
    scan(body);
    const fields = { provider, model, effort, enabled, tags: smith.tags };
    const eol = body.includes("\r\n") ? "\r\n" : "\n";
    const lead = body === "" ? "" : body.endsWith("\n") ? eol : `${eol}${eol}`;
    const block = [
      `[${["smiths", name].map(segment).join(".")}]`,
      ...Object.entries(fields).map(
        ([field, value]) => `${segment(field)} = ${literal(value)}`,
      ),
    ].join(eol);
    const next = `${body}${lead}${block}${eol}`;
    if (
      !Bun.deepEquals(
        parse(next),
        withValue(old, ["smiths", name], fields),
        true,
      )
    )
      throw new Refusal(
        `${source.file}: the candidate would change more than smiths.${name}`,
      );
    const text = bom + next;
    const effective = loadConfigFromContents({
      sources: { ...texts, [request.target]: { file: source.file, text } },
      env: request.env,
    });
    const bytes = Buffer.from(text);
    return {
      ok: true,
      value: {
        target: request.target,
        file: source.file,
        created: source.text === null,
        smith,
        bytes,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        sources: { user: user.fingerprint, workspace: workspace.fingerprint },
        effective,
      },
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Build one atomic candidate for all supported fields of an existing Smith.
 * The request is domain-shaped, the selected source is explicit, and the
 * effective result must equal the complete requested Smith. No file is read
 * by label or written by this pure function.
 */
export function buildSmithEditCandidate(
  value: SmithConfigEditPreviewRequest | unknown,
  sources: Record<ConfigTarget, ConfigByteSource>,
  env: Readonly<Record<string, string | undefined>>,
): SmithEditCandidateOutcome {
  try {
    const request = smithConfigEditPreviewRequestSchema.parse(value),
      user = capturedSource(sources.user),
      workspace = capturedSource(sources.workspace),
      sourceByTarget = { user, workspace },
      docs = { user: user.doc, workspace: workspace.doc },
      texts = { user: user.source, workspace: workspace.source },
      before = loadConfigFromByteContents({ sources, env });

    if (!Object.hasOwn(before.config.smiths, request.name))
      throw new Refusal(`unknown existing smith "${request.name}"`);

    const source = sourceByTarget[request.target],
      old = docs[request.target],
      targetRaw = at(old, ["smiths", request.name]);
    if (old.smiths !== undefined && !isTable(old.smiths))
      throw new Refusal(
        `${source.source.file}: smiths holds a value, not a table; change it by hand`,
      );

    if (targetRaw !== undefined && !isTable(targetRaw))
      throw new Refusal(
        `${source.source.file}: smiths.${request.name} is not a table; change it by hand`,
      );

    if (request.target === "workspace" && source.source.text === null) {
      const userPass = at(docs.user, ["execution", "env", "pass"]);
      if (Array.isArray(userPass) && userPass.length > 0)
        throw new Refusal(
          firstWorkspacePassRefusal(
            texts.user.file,
            texts.workspace.file,
            userPass.map(String),
          ),
        );
    }

    const body = source.source.text ?? "",
      bom = body.startsWith(BOM) ? BOM : "";
    let next = body.slice(bom.length),
      expected = old;
    scan(next);
    const table = ["smiths", request.name],
      fields: SmithConfigEditFields = {
        provider: request.smith.provider,
        model: request.smith.model,
        effort: request.smith.effort,
        enabled: request.smith.enabled,
        tags: [...request.smith.tags],
      };
    for (const field of Object.keys(
      fields,
    ) as (keyof SmithConfigEditFields)[]) {
      const shape = { table, field, kind: SMITH_FIELDS[field]! };
      next = edited(next, shape, fields[field], expected);
      expected = withValue(expected, [...table, field], fields[field]);
    }
    if (!Bun.deepEquals(parse(next), expected, true))
      throw new Refusal(
        `${source.source.file}: the candidate would change more than smiths.${request.name}`,
      );

    const text = bom + next,
      afterSources = {
        ...texts,
        [request.target]: { file: source.source.file, text },
      },
      effectiveAfter = loadConfigFromContents({ sources: afterSources, env }),
      effectiveBefore = before.config.smiths[request.name],
      effectiveResult = effectiveAfter.config.smiths[request.name];
    if (effectiveBefore === undefined || effectiveResult === undefined)
      throw new Refusal(
        `smiths.${request.name}: the selected Smith is unavailable in the effective configuration`,
      );
    if (!Bun.deepEquals(effectiveResult, request.smith, true))
      throw new Refusal(
        `smiths.${request.name}: the selected target would not make the requested complete Smith effective`,
      );

    const provenanceFor = (loaded: LoadedConfig) => {
      const result = {} as Record<keyof SmithConfigEditFields, string>;
      for (const field of Object.keys(
        fields,
      ) as (keyof SmithConfigEditFields)[]) {
        const sourceName =
          loaded.provenance[`smiths.${request.name}.${field}`]?.source;
        if (typeof sourceName !== "string")
          throw new Refusal(
            `smiths.${request.name}.${field}: source provenance is unavailable`,
          );
        result[field] = sourceName;
      }
      return result;
    };
    const targetBefore: SmithConfigEditTargetBefore | null =
      targetRaw === undefined
        ? null
        : Object.fromEntries(
            (Object.keys(fields) as (keyof SmithConfigEditFields)[])
              .filter((field) => Object.hasOwn(targetRaw, field))
              .map((field) => [field, structuredClone(targetRaw[field])]),
          );
    const review: SmithConfigEditReview = {
      name: request.name,
      targetBefore,
      targetAfter: structuredClone(request.smith),
      effectiveBefore: structuredClone(effectiveBefore),
      effectiveAfter: structuredClone(effectiveResult),
      provenanceBefore: provenanceFor(before),
      provenanceAfter: provenanceFor(effectiveAfter),
    };
    const bytes = Buffer.from(text);
    return {
      ok: true,
      value: {
        target: request.target,
        file: source.source.file,
        created: source.source.text === null,
        smith: structuredClone(request.smith),
        bytes,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        sources: {
          user: user.fingerprint,
          workspace: workspace.fingerprint,
        },
        review,
      },
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function capturedSource({ file, bytes }: ConfigByteSource) {
  const copy = bytes === null ? null : Buffer.from(bytes);
  const text = copy?.toString("utf8") ?? null;
  if (copy !== null && !Buffer.from(text ?? "", "utf8").equals(copy))
    throw new Refusal(
      `${file}: expected strict UTF-8 bytes; encoding repair is not a config edit`,
    );
  let doc: Table;
  try {
    doc = parse(text ?? "");
  } catch (error) {
    throw new Refusal(
      `${file} does not parse (${error instanceof Error ? error.message : String(error)}); change it by hand`,
    );
  }
  return {
    source: { file, text },
    doc,
    fingerprint: {
      file,
      sha256:
        copy === null ? null : createHash("sha256").update(copy).digest("hex"),
      byteLength: copy?.length ?? null,
    },
  };
}

function firstWorkspacePassRefusal(
  userFile: string,
  workspaceFile: string,
  userPassList: string[],
): string {
  return `creating ${workspaceFile} would stop execution.env.pass from ${userFile} (${userPassList.join(", ")}) applying: a workspace file never inherits it. Keep it there first: bun run forge:config set execution.env.pass "${userPassList.join(",")}" --workspace`;
}

export interface ConfigWriteControls {
  /** Trusted internal test seam, never an operator request field. */
  coordinationRoot?: string;
  waitMs?: number;
  signal?: AbortSignal;
}

/** Serialize a scalar CLI write; a replacement failure is explicitly unconfirmed. */
export async function setConfigValue(
  request: {
    key: string;
    raw: string;
    target: ConfigTarget;
    options: LoadOptions;
  },
  controls: ConfigWriteControls = {},
): Promise<SetOutcome> {
  const { key, raw, target, options } = request;
  const fail = (error: string): SetOutcome => ({ ok: false, error });
  const shape = keyShape(key);
  if (typeof shape === "string") return fail(shape);
  const typed = typedValue(shape.kind, raw);
  if (typeof typed === "string") return fail(`${key}: ${typed}`);
  const contents = { ...options.contents };
  try {
    // All paths/env are captured synchronously before the first await.
    const context = prepareConfigTransaction({
      options,
      target,
      ...(controls.coordinationRoot === undefined
        ? {}
        : { coordinationRoot: controls.coordinationRoot }),
    });
    return await withConfigTransaction(
      context,
      (transaction) =>
        setConfigValueHeld({
          key,
          shape,
          value: typed.value,
          context,
          transaction,
          contents,
        }),
      controls,
    );
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}

function setConfigValueHeld({
  key,
  shape,
  value,
  context,
  transaction,
  contents,
}: {
  key: string;
  shape: KeyShape;
  value: unknown;
  context: PreparedConfigTransaction;
  transaction: ConfigWriteTransaction;
  contents: { user?: string; workspace?: string };
}): SetOutcome {
  const target = context.target;
  const sources = transaction.sources;
  const userFile = context.files.user;
  const workspaceFile = context.files.workspace;
  const file = context.files[target];
  const fail = (error: string): SetOutcome => ({ ok: false, error });
  const userDoc = parsedSource(sources.user);
  const workspaceDoc = parsedSource(sources.workspace);
  const workspaceExists = sources.workspace.bytes !== null;

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
        firstWorkspacePassRefusal(userFile, workspaceFile, userPassList),
      );
    replacedUserPass = userPassList;
  }

  let original = "";
  try {
    original = decodeConfigText(
      file,
      sources[target].bytes ?? new Uint8Array(),
    );
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
    loadConfigFromByteContents({
      sources: {
        user: {
          file: userFile,
          bytes:
            target === "user"
              ? Buffer.from(next)
              : contents.user === undefined
                ? sources.user.bytes
                : Buffer.from(contents.user),
        },
        workspace: {
          file: workspaceFile,
          bytes:
            target === "workspace"
              ? Buffer.from(next)
              : contents.workspace === undefined
                ? sources.workspace.bytes
                : Buffer.from(contents.workspace),
        },
      },
      env: context.env,
    });
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }

  const publication = transaction.publish(
    Buffer.from(bom ? `${BOM}${next}` : next),
  );
  return {
    ok: true,
    key,
    value,
    file: publication.file,
    created: publication.created,
    ...(replacedUserPass !== undefined ? { replacedUserPass } : {}),
  };
}
