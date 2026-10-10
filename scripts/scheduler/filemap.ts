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
 * any level, or to a horizontal rule. Nothing but globs belongs in it: blank
 * lines and `<!-- -->` comment lines are skipped, a list bullet and
 * surrounding backticks are dropped, and any other line that is not a glob
 * refuses the whole map.
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

const FILES_HEADING = /^#{2,6}[ \t]+Files$/;
const ANY_HEADING = /^#{1,6}[ \t]+\S/;
/** A horizontal rule: it closes a section the way a heading does. */
const RULE = /^(-{3,}|_{3,}|\*{3,})$/;
const COMMENT = /^<!--.*-->$/;
const BULLET = /^[-*+][ \t]+/;
/** Characters no path holds: an unfilled `<placeholder>`, a drive, a quote, a pipe. */
const NOT_IN_A_PATH = /[<>:"|`]/;

/** The glob a line holds, or why it holds none. */
function globOf(written: string): { glob: string } | { why: string } {
  let entry = written.replace(BULLET, "");
  if (entry.length >= 2 && entry.startsWith("`") && entry.endsWith("`")) {
    entry = entry.slice(1, -1);
  }
  if (/\s/.test(entry)) {
    return { why: "has whitespace: one glob per line and nothing else" };
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
  const stray = NOT_IN_A_PATH.exec(entry);
  if (stray !== null) {
    return { why: `holds \`${stray[0]}\`, which no path does` };
  }
  while (entry.startsWith("./")) entry = entry.slice(2);
  if (entry.length === 0) return { why: "names nothing" };
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
    if (ANY_HEADING.test(line) || RULE.test(line)) break;
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
