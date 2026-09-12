/**
 * Bead builder — collect bead metadata, build a ready-to-paste `bd create`
 * command, copy to clipboard, modal confirm. Mirrors skill-builder.mjs.
 */

/**
 * @typedef {Object} BeadBuilderFormData
 * @property {string} title
 * @property {string} type
 * @property {string} priority
 * @property {string} repo
 * @property {string} description
 * @property {string} acceptanceCriteria
 * @property {string} labels
 */

/** @type {readonly string[]} */
export const BEAD_TYPES = ["task", "feature", "bug", "chore"];

/** @type {readonly string[]} */
export const BEAD_PRIORITIES = ["P0", "P1", "P2", "P3", "P4"];

/** @param {string} s */
function shellEscapeDoubleQuoted(s) {
  return String(s ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/`/g, "\\`")
    .replace(/\$/g, "\\$");
}

/**
 * Collapse newlines in descriptions to literal `\n` so the command stays on
 * one line. Single-quoted shells would need different handling, but our
 * README and /add-bead examples all use double-quoted `"..."` arguments.
 * @param {string} s
 */
function encodeDescriptionNewlines(s) {
  return String(s ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/\n/g, "\\n");
}

/** @param {string} s */
function normalizeLabels(s) {
  return String(s ?? "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean)
    .join(",");
}

/** @param {string} s */
function splitAcLines(s) {
  return String(s ?? "")
    .split(/\r?\n/)
    .map((t) => t.trim())
    .filter(Boolean);
}

/**
 * Build a single-line `bd create` command with sensible defaults and shell
 * escaping. Never emits empty flags.
 * @param {BeadBuilderFormData} d
 */
export function buildBdCreateCommand(d) {
  const title = String(d.title ?? "").trim();
  const type = BEAD_TYPES.includes(String(d.type).trim())
    ? String(d.type).trim()
    : "task";
  const priority = BEAD_PRIORITIES.includes(String(d.priority).trim())
    ? String(d.priority).trim()
    : "P2";
  const repo = String(d.repo ?? "").trim() || ".";
  const description = String(d.description ?? "").trim();
  const labels = normalizeLabels(d.labels);
  const acLines = splitAcLines(d.acceptanceCriteria);

  const parts = [
    "bd create",
    `--repo ${JSON.stringify(repo)}`,
    `--type ${type}`,
    `--priority ${priority}`,
    `--title "${shellEscapeDoubleQuoted(title)}"`,
  ];
  if (description) {
    // Shell-escape first so pre-existing backslashes/quotes are handled, then
    // encode real newlines as literal `\n` so the command stays on one line.
    parts.push(
      `--description "${encodeDescriptionNewlines(shellEscapeDoubleQuoted(description))}"`,
    );
  }
  if (labels) {
    parts.push(`--labels ${JSON.stringify(labels)}`);
  }
  for (const line of acLines) {
    // `--acceptance`, not `--ac`: bd rejects the short form with
    // "unknown flag: --ac", so the generated command used to fail on paste.
    parts.push(`--acceptance "${shellEscapeDoubleQuoted(line)}"`);
  }
  return parts.join(" ");
}
