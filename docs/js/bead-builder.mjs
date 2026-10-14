/**
 * Bead builder — collect bead metadata, build a ready-to-paste `bd create`
 * command, copy to clipboard, modal confirm. Mirrors skill-builder.mjs.
 */

/**
 * @typedef {Object} BeadBuilderFormData
 * @property {string} title
 * @property {string} type
 * @property {string} priority
 * @property {string} repo `.` for this checkout, or a sub-repo, named at the start of the title.
 * @property {string} description
 * @property {string} acceptanceCriteria
 * @property {string} labels
 * @property {string} [parent] The id of the parent bead, when the new one is its child.
 */

/**
 * The issue types a bead can be filed as. The control plane's create route
 * serves the same list (`scripts/hearth/routes/beads.ts`); a test holds the
 * two equal.
 * @type {readonly string[]}
 */
export const BEAD_TYPES = ["task", "feature", "bug", "chore", "epic"];

/** @type {readonly string[]} */
export const BEAD_PRIORITIES = ["P0", "P1", "P2", "P3", "P4"];

/**
 * One value as a single-quoted shell word. Inside single quotes a POSIX shell
 * expands nothing: no `$`, backtick, backslash or newline is special, and
 * bash's history expansion leaves `!` alone. Only a single quote ends the
 * text, so it is written `'\''`: close, an escaped quote, open again.
 * @param {string} s
 */
function shellQuote(s) {
  return `'${String(s ?? "").replace(/'/g, "'\\''")}'`;
}

/**
 * Line endings as `\n`. The newlines stay real: inside quotes a shell passes
 * them on as they are, where a written `\n` would reach bd as a backslash and
 * an n.
 * @param {string} s
 */
function normalizeNewlines(s) {
  return String(s ?? "").replace(/\r\n?/g, "\n");
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
 * The acceptance criteria as one text: a line each, trimmed, blank lines
 * dropped. Create sends this text, and the copied command passes the same.
 * @param {string} s
 */
export function acceptanceText(s) {
  return splitAcLines(s).join("\n");
}

/**
 * The sub-repo a Repo value names, or "" for this checkout's own tracker:
 * `./repos/rag-chat`, `repos/rag-chat/` and `rag-chat` all name `rag-chat`.
 * @param {string | undefined} s
 */
function repoName(s) {
  const name = String(s ?? "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^(\.\/)+/, "")
    .replace(/^repos\//, "")
    .replace(/\/+$/, "");
  return name === "." ? "" : name;
}

/**
 * The title as filed, by Create and by the copied command alike. Never
 * `--repo`: `.` is the only repository registered with bd, and given any
 * other value bd files the issue where nothing run here finds it. A sub-repo
 * is named at the start of the title instead, once.
 * @param {string | undefined} title
 * @param {string | undefined} repo
 */
export function titleWithRepo(title, repo) {
  const typed = String(title ?? "").trim();
  const name = repoName(repo);
  const tag = name ? `[${name}]` : "";
  return tag && !typed.toLowerCase().startsWith(tag.toLowerCase())
    ? `${tag} ${typed}`
    : typed;
}

/**
 * Build a `bd create` command with sensible defaults and shell escaping.
 * Never emits empty flags. It is one line unless the description or the
 * acceptance criteria have several: those stay on their own lines inside
 * their quoted value.
 * @param {BeadBuilderFormData} d
 */
export function buildBdCreateCommand(d) {
  const title = titleWithRepo(d.title, d.repo);
  const type = BEAD_TYPES.includes(String(d.type).trim())
    ? String(d.type).trim()
    : "task";
  const priority = BEAD_PRIORITIES.includes(String(d.priority).trim())
    ? String(d.priority).trim()
    : "P2";
  const description = String(d.description ?? "").trim();
  const labels = normalizeLabels(d.labels);
  const parent = String(d.parent ?? "").trim();
  const acceptance = acceptanceText(d.acceptanceCriteria);

  // Type and priority are words from fixed lists; every other value is quoted.
  const parts = ["bd create", `--type ${type}`, `--priority ${priority}`];
  if (parent) {
    parts.push(`--parent ${shellQuote(parent)}`);
  }
  parts.push(`--title ${shellQuote(title)}`);
  if (description) {
    parts.push(`--description ${shellQuote(normalizeNewlines(description))}`);
  }
  if (labels) {
    parts.push(`--labels ${shellQuote(labels)}`);
  }
  if (acceptance) {
    // `--acceptance`, not `--ac`: bd rejects the short form with
    // "unknown flag: --ac", so the generated command used to fail on paste.
    // One flag for every line: bd keeps only the last of a repeated
    // `--acceptance`.
    parts.push(`--acceptance ${shellQuote(acceptance)}`);
  }
  return parts.join(" ");
}
