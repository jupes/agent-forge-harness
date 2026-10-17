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
/** How much of one failing test's lines is kept: its first part, where the error and the diff's start are. */
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
 * For each failing test, once, the lines bun printed for it: those since the
 * last boundary line, its `(fail)` line, and a timeout note after it. Blocks
 * are separated by a blank line, and a block with no line of its own beyond a
 * `(fail)` already given (the summary's list) is left out. Empty when no test
 * failed.
 */
export function failureBlocks(output: string): string {
  const lines = output.replace(COLOUR, "").split(/\r?\n/);
  const blocks: string[] = [];
  const given = new Set<string>();
  let start = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (!BOUNDARY.test(line)) continue;
    if (FAIL.test(line) && !given.has(line)) {
      given.add(line);
      const own = lines.slice(start, i + 1);
      const note = lines[i + 1];
      if (note !== undefined && TIMEOUT_NOTE.test(note)) own.push(note);
      const fail = own.indexOf(line);
      const before = own.slice(0, fail).join("\n");
      const after = own.slice(fail).join("\n");
      blocks.push(
        before === ""
          ? after
          : `${cut(before, BLOCK_CHARS - after.length, "[cut]")}\n${after}`,
      );
    }
    start = i + 1;
  }
  return cut(blocks.join("\n\n"), BLOCKS_CHARS, "[more failures cut]");
}

/** What a failing re-run file's message carries: its failing tests' blocks, and the end of its output. */
export function rerunReport(output: string): {
  failures: string;
  tail: string;
} {
  return { failures: failureBlocks(output), tail: output.slice(-TAIL_CHARS) };
}
