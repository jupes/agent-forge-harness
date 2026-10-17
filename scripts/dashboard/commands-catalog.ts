#!/usr/bin/env bun

/**
 * The Commands page's lists of slash commands and skills, generated from
 * `.claude/commands/*.md` and `.claude/skills/<name>/SKILL.md`.
 *
 * A command file opens with a frontmatter block holding `argument-hint` (the
 * arguments the row shows; `""` for a command that takes none), and its first
 * heading is `# /<name> — <description>`, `<name>` being the file's own name.
 * A skill's frontmatter holds `name` (the folder's name) and `description`; the
 * row shows the description without its "Use when ..." trigger text, cut to
 * `SUMMARY_LIMIT` characters (see `summarizeDescription`). A skill folder with
 * no `SKILL.md` is an error.
 *
 * The rows are written to `docs/js/generated/commands.ts` and
 * `docs/js/generated/skills.ts`, which the page imports, so the page needs no
 * server; `scripts/dashboard/commands-catalog.test.ts` fails when either file is
 * not what this script writes, so a new command or skill cannot be left off.
 *
 * Usage: bun run dashboard:commands
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parse } from "yaml";
import { splitFrontmatter } from "../frontmatter";
import { isMain } from "../is-main";

export interface CommandEntry {
  /** The slash command, `/<file name>`. */
  name: string;
  /** The file's `argument-hint`; empty for a command that takes no arguments. */
  argumentHint: string;
  /** The first heading's text after the em dash. */
  description: string;
}

export interface SkillEntry {
  /** The skill's name, which is its folder's name. */
  name: string;
  /** The description without its trigger text, cut to `SUMMARY_LIMIT`. */
  summary: string;
}

/** The generated modules, relative to the harness root. */
export const CATALOG_MODULE = "docs/js/generated/commands.ts";
export const SKILLS_MODULE = "docs/js/generated/skills.ts";

/** The longest a skill's summary gets, its ellipsis included. */
export const SUMMARY_LIMIT = 160;

type Parsed<Entry> = { ok: true; entry: Entry } | { ok: false; error: string };

type Fields =
  | { ok: true; data: Record<string, unknown> | null; body: string }
  | { ok: false; error: string };

const HEADING = /^#\s+(.*?)\s*$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describeValue(value: unknown): string {
  if (value === null || value === undefined) return "nothing";
  if (Array.isArray(value)) return "a list";
  if (isRecord(value)) return "a mapping";
  return `a ${typeof value}`;
}

/** The file's frontmatter fields (null when it has no block) and the text after the block. */
function frontmatterFields(file: string, text: string): Fields {
  const { raw, body } = splitFrontmatter(text);
  if (raw === null) return { ok: true, data: null, body };
  try {
    const data: unknown = parse(raw);
    return { ok: true, data: isRecord(data) ? data : {}, body };
  } catch (error) {
    const reason = (error instanceof Error ? error.message : String(error))
      .split(/\r?\n/)[0]
      ?.trim();
    return {
      ok: false,
      error: `${file}: the frontmatter is not valid YAML: ${reason}`,
    };
  }
}

export function parseCommandFile(
  file: string,
  text: string,
): Parsed<CommandEntry> {
  const name = `/${file.replace(/\.md$/, "")}`;
  const fields = frontmatterFields(file, text);
  if (!fields.ok) return fields;
  if (fields.data === null || !("argument-hint" in fields.data)) {
    return {
      ok: false,
      error: `${file}: the frontmatter must have an argument-hint (use "" for a command that takes no arguments)`,
    };
  }
  const hint = fields.data["argument-hint"];
  if (typeof hint !== "string") {
    const advice =
      hint === null || hint === undefined
        ? 'write "" for a command that takes no arguments'
        : Array.isArray(hint)
          ? 'quote it: "[task]" is a string, an unquoted [task] is a YAML list'
          : "quote it";
    return {
      ok: false,
      error: `${file}: argument-hint must be a string, found ${describeValue(hint)} (${advice})`,
    };
  }

  let heading: string | undefined;
  for (const line of fields.body.split(/\r?\n/)) {
    const match = HEADING.exec(line);
    if (match) {
      heading = match[1];
      break;
    }
  }
  const prefix = `${name} — `;
  const description = heading?.startsWith(prefix)
    ? heading.slice(prefix.length).trim()
    : "";
  if (description) {
    return {
      ok: true,
      entry: { name, argumentHint: hint.trim(), description },
    };
  }
  return {
    ok: false,
    error: `${file}: the first heading must be "# ${name} — <description>", found ${
      heading === undefined ? "none" : `"# ${heading}"`
    }`,
  };
}

function byName(a: { name: string }, b: { name: string }): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/** Every `*.md` under `dir`, by command name. */
export function catalogFromDir(dir: string): {
  entries: CommandEntry[];
  errors: string[];
} {
  const entries: CommandEntry[] = [];
  const errors: string[] = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".md"))) {
    const parsed = parseCommandFile(
      file,
      readFileSync(join(dir, file), "utf8"),
    );
    if (parsed.ok) entries.push(parsed.entry);
    else errors.push(parsed.error);
  }
  entries.sort(byName);
  return { entries, errors };
}

/** A description opens its trigger text with "Use when", "Use this" or "Use for". */
const TRIGGER = /\s+Use\s+(?:when|this|for)\b/;

/**
 * What the Skills table shows of a skill's description: the text before its
 * trigger text, on one line, at most `SUMMARY_LIMIT` characters. A longer one is
 * cut at a word and ends with "…".
 *
 * It is not the first sentence: the Forge phase skills open with "Phase 3 of the
 * Forge pipeline.", which says nothing of what the skill does. The trigger text
 * is what the page can drop, since agents read it and the page's reader does not.
 */
export function summarizeDescription(description: string): string {
  const text = description.replace(/\s+/g, " ").trim();
  const trigger = TRIGGER.exec(text);
  const what = trigger ? text.slice(0, trigger.index) : text;
  if (what.length <= SUMMARY_LIMIT) return what;
  const room = SUMMARY_LIMIT - 1;
  const head = what.slice(0, room);
  const space = head.lastIndexOf(" ");
  const words = what[room] === " " || space < 0 ? head : head.slice(0, space);
  return `${words.replace(/[\s,;:—–-]+$/, "")}…`;
}

/** `file` is `<folder>/<file name>`; the folder names the skill. */
export function parseSkillFile(file: string, text: string): Parsed<SkillEntry> {
  const folder = file.split("/")[0] ?? file;
  const fields = frontmatterFields(file, text);
  if (!fields.ok) return fields;
  if (fields.data === null) {
    return {
      ok: false,
      error: `${file}: the file must open with a frontmatter block holding a name and a description`,
    };
  }
  const { name, description } = fields.data;
  if (name !== folder) {
    return {
      ok: false,
      error: `${file}: name must be "${folder}", found ${
        typeof name === "string" ? JSON.stringify(name) : describeValue(name)
      }`,
    };
  }
  if (typeof description !== "string" || description.trim() === "") {
    return {
      ok: false,
      error: `${file}: the frontmatter must have a description`,
    };
  }
  return {
    ok: true,
    entry: {
      name,
      summary: summarizeDescription(description),
    },
  };
}

/**
 * Every folder under `dir`, by skill name. A skill is the folder's `SKILL.md`.
 */
export function skillsFromDir(dir: string): {
  entries: SkillEntry[];
  errors: string[];
} {
  const entries: SkillEntry[] = [];
  const errors: string[] = [];
  const folders = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  for (const folder of folders) {
    const file = "SKILL.md";
    if (!existsSync(join(dir, folder, file))) {
      errors.push(`${folder}: the folder has no SKILL.md`);
      continue;
    }
    const parsed = parseSkillFile(
      `${folder}/${file}`,
      readFileSync(join(dir, folder, file), "utf8"),
    );
    if (parsed.ok) entries.push(parsed.entry);
    else errors.push(parsed.error);
  }
  entries.sort(byName);
  return { entries, errors };
}

/** The harness root, where the repo's formatter and its configuration are. */
const HARNESS_ROOT = resolve(import.meta.dir, "..", "..");

/**
 * What `bun run lint` leaves alone: `text` run through the repo's own formatter
 * (the installed binary, never fetched). The formatter, not this file, decides
 * the quote a string is written in, where a long line breaks and how wide a
 * character is, so a summary or a hint with quotes, a backslash or wide
 * characters in it cannot make the generated module fail the lint.
 */
function format(text: string): string {
  const bin = ["biome.exe", "biome"]
    .map((name) => join(HARNESS_ROOT, "node_modules", ".bin", name))
    .find((path) => existsSync(path));
  if (bin === undefined) {
    throw new Error(
      "node_modules/.bin/biome is not installed: run bun install, then bun run dashboard:commands again",
    );
  }
  const run = Bun.spawnSync(
    [bin, "format", "--stdin-file-path", join(HARNESS_ROOT, CATALOG_MODULE)],
    {
      cwd: HARNESS_ROOT,
      stdin: Buffer.from(text),
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  if (run.exitCode !== 0) {
    throw new Error(
      `the formatter failed on a generated module: ${run.stderr.toString().trim()}`,
    );
  }
  return run.stdout.toString();
}

/** One property line, each value a JSON string literal: the formatter settles its quote and its line. */
function property(key: string, value: string | boolean): string {
  return `    ${key}: ${JSON.stringify(value)},\n`;
}

/** A generated module's text: one object per entry, formatted. */
function renderModule(
  header: readonly string[],
  type: string,
  exportName: string,
  rows: readonly (readonly [string, string | boolean])[][],
): string {
  return format(
    [
      "/**\n",
      ...header.map((line) => ` * ${line}\n`),
      " */\n",
      "\n",
      `import type { ${type} } from "../../../scripts/dashboard/commands-catalog";\n`,
      "\n",
      `export const ${exportName}: readonly ${type}[] = [\n`,
      ...rows.map(
        (row) =>
          `  {\n${row.map(([key, value]) => property(key, value)).join("")}  },\n`,
      ),
      "];\n",
    ].join(""),
  );
}

/** The generated commands module's text. */
export function renderCatalogModule(entries: readonly CommandEntry[]): string {
  return renderModule(
    [
      "Generated by `bun run dashboard:commands` from the argument-hint and first heading of",
      "each `.claude/commands/*.md`. Do not edit: change the command file and run it again.",
    ],
    "CommandEntry",
    "COMMANDS",
    entries.map((entry) => [
      ["name", entry.name],
      ["argumentHint", entry.argumentHint],
      ["description", entry.description],
    ]),
  );
}

/** The generated skills module's text. */
export function renderSkillsModule(entries: readonly SkillEntry[]): string {
  return renderModule(
    [
      "Generated by `bun run dashboard:commands` from the name and description of each",
      "`.claude/skills/<name>/SKILL.md`. Do not edit: change the skill file and run it again.",
    ],
    "SkillEntry",
    "SKILLS",
    entries.map((entry) => [
      ["name", entry.name],
      ["summary", entry.summary],
    ]),
  );
}

export type GenerateResult =
  | {
      ok: true;
      data: { wrote: string[]; commands: number; skills: number };
    }
  | { ok: false; error: string };

/** Reads the harness at `root` and writes both modules; writes neither when a file does not parse. */
export function generate(root: string): GenerateResult {
  const commands = catalogFromDir(join(root, ".claude", "commands"));
  const skills = skillsFromDir(join(root, ".claude", "skills"));
  const errors = [...commands.errors, ...skills.errors];
  if (errors.length > 0) return { ok: false, error: errors.join("\n") };
  mkdirSync(dirname(join(root, CATALOG_MODULE)), { recursive: true });
  writeFileSync(
    join(root, CATALOG_MODULE),
    renderCatalogModule(commands.entries),
  );
  writeFileSync(join(root, SKILLS_MODULE), renderSkillsModule(skills.entries));
  return {
    ok: true,
    data: {
      wrote: [CATALOG_MODULE, SKILLS_MODULE],
      commands: commands.entries.length,
      skills: skills.entries.length,
    },
  };
}

if (isMain(import.meta)) {
  const result = generate(resolve(import.meta.dir, "..", ".."));
  if (!result.ok) {
    console.error(
      JSON.stringify({ ok: false, data: null, error: result.error }),
    );
    process.exit(1);
  }
  console.log(JSON.stringify({ ok: true, data: result.data, error: null }));
}
