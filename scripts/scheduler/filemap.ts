/**
 * The file map of a task: the globs it may touch.
 *
 * A task's description carries the map as a section headed `Files`, one glob
 * per line, relative to the repository root:
 *
 *   ## Files
 *   scripts/scheduler/filemap.ts
 *   scripts/scheduler/*.test.ts
 *
 * The heading is `##` in a task description; a deeper level is read the same
 * way, so a plan can carry one map per checkpoint. Only the first `Files`
 * heading in the text is read, and its section runs to the next heading of
 * level two or deeper, or to a horizontal rule.
 *
 * A glob is a relative path, with forward slashes, in which `*` stands for
 * any run of characters inside one segment, `**` for any number of segments
 * and `?` for one character. Every other character stands for itself,
 * brackets included; `{a,b}` alternation is not part of the format.
 *
 * Nothing but globs belongs in the section: blank lines and one-line
 * `<!-- -->` comments are skipped, a list bullet and surrounding backticks
 * are dropped, a leading `./` is dropped and a trailing `/` means everything
 * under it. Any other line that is not a glob refuses the whole map, and a
 * line is judged as the glob it becomes, after those are dropped.
 *
 * Pure: text in, globs or a typed refusal out. What a map that is missing,
 * empty or invalid means for the task is the caller's decision.
 */

export interface FileMapProblem {
  /** 1-based line in the text the parser was given. */
  line: number;
  /** The line as written, trimmed. */
  text: string;
  why: string;
}

export type FileMap =
  | { ok: true; globs: string[] }
  | { ok: false; reason: "missing" | "empty"; error: string }
  | { ok: false; reason: "invalid"; error: string; problems: FileMapProblem[] };

/** A plan checkpoint and the file map under it. */
export interface CheckpointFileMap {
  /** The checkpoint's heading text, without its `###`. */
  checkpoint: string;
  map: FileMap;
}

const FILES_HEADING = /^#{2,6}[ \t]+Files$/;
/** A heading that closes the section. A lone `#` line inside it is not one: see `globOf`. */
const SECTION_HEADING = /^#{2,6}[ \t]+\S/;
/** A horizontal rule: it closes a section the way a heading does. */
const RULE = /^(-{3,}|_{3,}|\*{3,})$/;
const COMMENT = /^<!--.*-->$/;
const BULLET = /^[-*+][ \t]+/;
/** Characters no path holds: an unfilled `<placeholder>`, a drive, a quote, a pipe. */
const NOT_IN_A_PATH = /[<>:"|`]/;
const CHECKPOINT_HEADING = /^###[ \t]+(Checkpoint\b.*)$/;
/** A heading of a checkpoint's own level or above: where the checkpoint ends. */
const CHECKPOINT_END = /^#{1,3}[ \t]+\S/;

/** A character nobody can see: a control, or a zero-width or direction mark. */
function hasInvisible(text: string): boolean {
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (
      (code < 0x20 && code !== 0x09) ||
      (code >= 0x7f && code <= 0x9f) ||
      (code >= 0x200b && code <= 0x200f) ||
      (code >= 0x2028 && code <= 0x202f) ||
      (code >= 0x2060 && code <= 0x206f) ||
      code === 0xfeff
    ) {
      return true;
    }
  }
  return false;
}

/** The glob a line holds, or why it holds none. */
function globOf(written: string): { glob: string } | { why: string } {
  if (/^#[ \t]/.test(written)) {
    return {
      why: "is a `#` line: a comment is `<!-- … -->`, and a section starts with `##`",
    };
  }
  // What the line becomes first: every check below is on that.
  let entry = written.replace(BULLET, "");
  if (entry.length >= 2 && entry.startsWith("`") && entry.endsWith("`")) {
    entry = entry.slice(1, -1);
  }
  while (entry.startsWith("./")) entry = entry.slice(2);

  if (hasInvisible(entry)) {
    return { why: "holds an invisible character" };
  }
  if (/\s/.test(entry)) {
    return { why: "has whitespace: one glob per line and nothing else" };
  }
  if (entry.length === 0 || entry === "." || /^[-+]$/.test(entry)) {
    return { why: "names nothing" };
  }
  if (/^([/\\~]|[A-Za-z]:)/.test(entry)) {
    return { why: "is absolute: a glob is relative to the repository root" };
  }
  if (entry.split(/[/\\]/).includes("..")) {
    return { why: "leaves the repository (a `..` segment)" };
  }
  if (entry.includes("\\")) {
    return { why: "uses a backslash: write paths with forward slashes" };
  }
  if (entry.startsWith("!")) {
    return {
      why: "is a negation: a file map lists only what the task touches",
    };
  }
  if (/[{}]/.test(entry)) {
    return {
      why: "uses `{}` alternation, which is not part of the format: write one glob per line",
    };
  }
  const stray = NOT_IN_A_PATH.exec(entry);
  if (stray !== null) {
    return { why: `holds \`${stray[0]}\`, which no path does` };
  }
  return { glob: entry.endsWith("/") ? `${entry}**` : entry };
}

export function parseFileMap(text: string): FileMap {
  const lines = text.split(/\r?\n/).map((line) => line.trim());
  const heading = lines.findIndex((line) => FILES_HEADING.test(line));
  if (heading < 0) {
    return { ok: false, reason: "missing", error: "no `Files` section" };
  }

  const globs: string[] = [];
  const problems: FileMapProblem[] = [];
  for (let at = heading + 1; at < lines.length; at++) {
    const line = lines[at] as string;
    if (SECTION_HEADING.test(line) || RULE.test(line)) break;
    if (line.length === 0 || COMMENT.test(line)) continue;
    const read = globOf(line);
    if ("why" in read) {
      problems.push({ line: at + 1, text: line, why: read.why });
    } else if (!globs.includes(read.glob)) {
      globs.push(read.glob);
    }
  }

  if (problems.length > 0) {
    return {
      ok: false,
      reason: "invalid",
      error: `the \`Files\` section holds ${problems.length === 1 ? "a line that is" : "lines that are"} not a glob: ${problems
        .map((problem) => `line ${problem.line} ${problem.why}`)
        .join("; ")}`,
      problems,
    };
  }
  if (globs.length === 0) {
    return {
      ok: false,
      reason: "empty",
      error: "the `Files` section lists no glob",
    };
  }
  return { ok: true, globs };
}

/**
 * The file map of every checkpoint of a plan document, in order.
 *
 * `parseFileMap` reads the first `Files` section of a text, so a plan has to
 * be read checkpoint by checkpoint: each `### Checkpoint …` heading opens one,
 * and it runs to the next heading of its own level or above. Line numbers in
 * a refusal count from the checkpoint's heading.
 */
export function parsePlanFileMaps(plan: string): CheckpointFileMap[] {
  const lines = plan.split(/\r?\n/);
  const found: CheckpointFileMap[] = [];
  for (let at = 0; at < lines.length; at++) {
    const title = CHECKPOINT_HEADING.exec((lines[at] as string).trim())?.[1];
    if (title === undefined) continue;
    let end = at + 1;
    while (
      end < lines.length &&
      !CHECKPOINT_END.test((lines[end] as string).trim())
    ) {
      end++;
    }
    found.push({
      checkpoint: title.trim(),
      map: parseFileMap(lines.slice(at, end).join("\n")),
    });
    at = end - 1;
  }
  return found;
}
