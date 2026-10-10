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
 * any run of characters inside one segment, `?` for one character, and a
 * segment that is exactly `**` for any number of segments. Every other
 * character stands for itself, brackets included; `{a,b}` alternation is not
 * part of the format, and `**` inside a longer segment means nothing here.
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
  /** The checkpoint's heading text, without its `#`s. */
  checkpoint: string;
  map: FileMap;
}

const FILES_HEADING = /^#{2,6}[ \t]+Files$/;
/** A heading that closes the section. A `#` line inside it is not one: see `globOf`. */
const SECTION_HEADING = /^#{2,6}[ \t]+\S/;
/** A horizontal rule: it closes a section the way a heading does. */
const RULE = /^(-{3,}|_{3,}|\*{3,})$/;
const COMMENT = /^<!--.*-->$/;
const BULLET = /^[-*+][ \t]+/;
/** Characters no path holds: an unfilled `<placeholder>`, a drive, a quote, a pipe. */
const NOT_IN_A_PATH = /[<>:"|`]/;
/** Format characters (zero-width, direction marks, soft hyphen) and line or paragraph separators. */
const FORMAT_CHARACTER = /[\p{Cf}\p{Zl}\p{Zp}]/u;
const CONTROL_CHARACTER = /\p{Cc}/u;
const ANY_HEADING = /^(#{1,6})[ \t]+\S/;
const CHECKPOINT_HEADING = /^(#{2,6})[ \t]+(Checkpoint\b.*)$/;
const FENCE = /^(```|~~~)/;

/** The glob a line holds, or why it holds none. */
function globOf(written: string): { glob: string } | { why: string } {
  if (written.startsWith("#")) {
    return {
      why: "starts with `#`: a comment is `<!-- … -->`, and a section starts with `##`",
    };
  }
  // What the line becomes first: every check below is on that.
  let entry = written.replace(BULLET, "");
  if (entry.length >= 2 && entry.startsWith("`") && entry.endsWith("`")) {
    entry = entry.slice(1, -1);
  }
  while (entry.startsWith("./")) entry = entry.slice(2);

  // A tab is whitespace, and is reported as that.
  if (
    FORMAT_CHARACTER.test(entry) ||
    CONTROL_CHARACTER.test(entry.replaceAll("\t", ""))
  ) {
    return { why: "holds a control or format character, which cannot be seen" };
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
  const segments = entry.split(/[/\\]/);
  if (segments.includes("..")) {
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
  if (segments.some((segment) => segment.includes("**") && segment !== "**")) {
    return {
      why: "has `**` inside a segment: `**` stands for whole segments, `*` for part of one",
    };
  }
  return { glob: entry.endsWith("/") ? `${entry}**` : entry };
}

/**
 * The map in `lines` (already trimmed). `offset` is how many lines of the
 * whole text come before them, so a refusal names the line of the text.
 */
function readMap(lines: readonly string[], offset: number): FileMap {
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
      problems.push({ line: offset + at + 1, text: line, why: read.why });
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

export function parseFileMap(text: string): FileMap {
  return readMap(
    text.split(/\r?\n/).map((line) => line.trim()),
    0,
  );
}

/**
 * The file map of every checkpoint of a plan document, in order.
 *
 * `parseFileMap` reads the first `Files` section of a text, so a plan has to
 * be read checkpoint by checkpoint. A heading whose text starts with
 * `Checkpoint` opens one, at whatever level it was written. It runs to the
 * next checkpoint heading, or to the next heading of its own level or above;
 * a `Files` heading of its own level or deeper is its map and not its end,
 * and a `#` line inside a fenced block is not a heading. Line numbers in a
 * refusal are lines of the plan.
 *
 * A checkpoint heading always opens a checkpoint, fenced or not: a fence
 * that is opened oddly or never closed may stretch one checkpoint, and must
 * never hide the ones after it.
 */
export function parsePlanFileMaps(plan: string): CheckpointFileMap[] {
  const lines = plan.split(/\r?\n/).map((line) => line.trim());
  const found: CheckpointFileMap[] = [];
  for (let at = 0; at < lines.length; at++) {
    const opened = CHECKPOINT_HEADING.exec(lines[at] as string);
    if (opened === null) continue;
    const level = (opened[1] as string).length;

    let end = at + 1;
    let fenced = false;
    for (; end < lines.length; end++) {
      const next = lines[end] as string;
      if (CHECKPOINT_HEADING.test(next)) break;
      if (FENCE.test(next)) {
        fenced = !fenced;
        continue;
      }
      if (fenced) continue;
      const depth = ANY_HEADING.exec(next)?.[1]?.length;
      if (depth === undefined) continue;
      if (FILES_HEADING.test(next) && depth >= level) continue;
      if (depth <= level) break;
    }
    found.push({
      checkpoint: (opened[2] as string).trim(),
      map: readMap(lines.slice(at, end), at),
    });
    at = end - 1;
  }
  return found;
}
