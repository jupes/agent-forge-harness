/**
 * What the isolation guard's re-run (`test-isolation.test.ts`) keeps of a
 * failing `bun test`'s output, for its failure message.
 *
 * The end of the output alone is not enough. On a CI runner bun prints a line
 * for every test, so a failure early in a long file is followed by many
 * `(pass)` lines and the summary: the end then names the failing test but no
 * longer holds its error or diff (bead agent-forge-harness-vhiz). Bun prints
 * a failing test's source excerpt, error and diff before its `(fail)` line,
 * and a timeout note straight after it; those lines are kept for each
 * failing test, with the end of the output for a failure outside any test.
 */

/** How much of the end of the output is kept. */
export const TAIL_CHARS = 1_500;
/** How much of one failing test's lines is kept; when they are longer, bun's report of the failure is kept first (`keep`). */
export const BLOCK_CHARS = 4_000;
/** How much of all the failing tests' lines is kept. */
export const BLOCKS_CHARS = 12_000;

// biome-ignore lint/suspicious/noControlCharactersInRegex: matches the escape that starts a colour code.
const COLOUR = /\u001b\[[0-9;]*m/g;

/** A line after which the next test's lines start: a test's result, a file's header, a summary heading. */
const BOUNDARY =
  /^(\((pass|fail|skip|todo)\) |##\[group\]|::endgroup::|\S.*\.(test|spec)\.[cm]?[jt]sx?:$|\d+ tests? (failed|skipped|todo):?$)/;
const FAIL = /^\(fail\) /;
const TIMEOUT_NOTE = /^\s*\^ this test timed out after /;

function cut(text: string, limit: number, note: string): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}\n${note}`;
}

/**
 * For each failing test, once, the lines printed for it: those since the
 * last boundary line or timeout note (cut by `keep`), its `(fail)` line, and
 * a timeout note after it. Blocks are separated by a blank line; a `(fail)`
 * line already given (the summary's list) gives no second block. Empty when
 * no test failed.
 */
export function failureBlocks(output: string): string {
  const lines = output.replace(COLOUR, "").split(/\r?\n/);
  const blocks: string[] = [];
  const given = new Set<string>();
  let start = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (!BOUNDARY.test(line)) continue;
    const note = lines[i + 1];
    const noted = note !== undefined && TIMEOUT_NOTE.test(note);
    if (FAIL.test(line) && !given.has(line)) {
      given.add(line);
      const after = (noted ? [line, note] : [line]).join("\n");
      const before = lines.slice(start, i);
      const kept = keep(before, Math.max(0, BLOCK_CHARS - after.length));
      blocks.push(kept === "" ? after : `${kept}\n${after}`);
    }
    // The note belongs to this test: the next block starts after it.
    if (noted) i++;
    start = i + 1;
  }
  return cut(blocks.join("\n\n"), BLOCKS_CHARS, "[more failures cut]");
}

/** A line of the source excerpt bun prints above a test's error. */
const EXCERPT = /^\s*\d+ \| /;
/** A source excerpt ends at bun's caret, unlike excerpt-shaped diff lines. */
const CARET = /^\s*\^\s*$/;
/**
 * The line bun prints an error under: `error: ` for an `Error` or an expect
 * failure, the error's name for a subclass (`TypeError: `, `RangeError: `).
 */
const ERROR_LINE = /^(\w*Error|error): /;

/**
 * Where bun's own report of a failure starts in the lines before its `(fail)`
 * line: the latest report outside an expect diff. A caret anchors custom
 * names and non-Error throws; a later caret-less error can supersede it.
 * Custom names without a caret need a following Bun stack frame.
 */
function reportStart(before: readonly string[]): number | null {
  let start: number | null = null;
  let caretError = -1;
  let diff: "awaiting" | "body" | null = null;
  for (let k = 0; k < before.length; k++) {
    const line = before[k] ?? "";
    if (diff !== null) {
      if (line === "") {
        if (diff === "body") diff = null;
      } else diff = "body";
      continue;
    }
    // Bun indents context lines inside multiline diffs, including their error.
    if (
      k > 0 &&
      CARET.test(line) &&
      EXCERPT.test(before[k - 1] ?? "") &&
      /^\S/.test(before[k + 1] ?? "")
    ) {
      start = k - 1;
      while (start > 0 && EXCERPT.test(before[start - 1] ?? "")) start--;
      caretError = k + 1;
    } else if (
      k !== caretError &&
      (ERROR_LINE.test(line) ||
        (/^\w+: /.test(line) && /^ {6}at /.test(before[k + 1] ?? "")))
    ) {
      start = k;
    }
    if (/^error: expect\(/.test(line) && before[k + 1] === "")
      diff = "awaiting";
  }
  return start;
}

/**
 * The lines before a `(fail)` line, in at most `budget` characters: all of
 * them when they fit; else bun's report, from its start (`reportStart`), so
 * the error and the diff's start are kept whatever the test printed before
 * it; else, with no report to find, the lines nearest the `(fail)` line.
 * Anything left out is marked `[cut]`.
 */
function keep(before: readonly string[], budget: number): string {
  const all = before.join("\n");
  if (all.length <= budget) return all;
  const from = reportStart(before);
  if (from !== null) {
    const report = before.slice(from).join("\n");
    const head = from > 0 ? "[cut]\n" : "";
    return `${head}${cut(report, Math.max(0, budget - head.length), "[cut]")}`;
  }
  const end: string[] = [];
  let used = 0;
  for (let k = before.length - 1; k >= 0; k--) {
    const line = before[k] ?? "";
    if (used + line.length + 1 > budget) break;
    end.unshift(line);
    used += line.length + 1;
  }
  return ["[cut]", ...end].join("\n");
}

/** What a failing re-run file's message carries: its failing tests' blocks, and the end of its output. */
export function rerunReport(output: string): {
  failures: string;
  tail: string;
} {
  return { failures: failureBlocks(output), tail: output.slice(-TAIL_CHARS) };
}
