/**
 * Splits the frontmatter block off a markdown file.
 *
 * Command files and skill files may open with a block between two `---` lines.
 * This only finds the block; reading its fields is up to the caller, so a caller
 * that merely drops the block (`scripts/sync-codex.ts`) needs no YAML parser.
 */

export interface SplitFrontmatter {
  /** The text between the two `---` lines, or null when the file has no frontmatter. */
  raw: string | null;
  /** The text after the closing `---` line, or the whole file when there is no frontmatter. */
  body: string;
}

const BYTE_ORDER_MARK = String.fromCharCode(0xfeff);
const OPENING = /^---[ \t]*\r?\n/;
const CLOSING = /^---[ \t]*(?:\r?\n|$)/m;

export function splitFrontmatter(text: string): SplitFrontmatter {
  const unmarked = text.startsWith(BYTE_ORDER_MARK) ? text.slice(1) : text;
  const opening = OPENING.exec(unmarked);
  if (!opening) return { raw: null, body: text };
  const rest = unmarked.slice(opening[0].length);
  const closing = CLOSING.exec(rest);
  if (!closing) return { raw: null, body: text };
  return {
    raw: rest.slice(0, closing.index).replace(/\r?\n$/, ""),
    body: rest.slice(closing.index + closing[0].length),
  };
}
