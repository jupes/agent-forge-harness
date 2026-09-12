/**
 * Skill builder — collect skill spec, build agent prompt, copy to clipboard, modal confirm.
 */

/**
 * @typedef {Object} SkillBuilderFormData
 * @property {string} skillName
 * @property {string} description
 * @property {string} whenToUse
 * @property {string} workflow
 * @property {string} additionalNotes
 */

/**
 * Folder name under `.claude/skills/<name>/` — lowercase kebab-case, no spaces.
 * @param {string} raw
 */
export function folderNameForSkill(raw) {
  let s = String(raw ?? "")
    .trim()
    .toLowerCase();
  s = s.replace(/[^a-z0-9]+/g, "-");
  s = s.replace(/-+/g, "-").replace(/^-|-$/g, "");
  return s || "skill";
}

/** @param {string} s */
function mdTableCell(s) {
  return String(s ?? "")
    .trim()
    .replace(/\|/g, "·")
    .replace(/\r?\n/g, " ");
}

/** @param {SkillBuilderFormData} d */
export function buildAuthoringPrompt(d) {
  const rawName = d.skillName.trim();
  const folder = folderNameForSkill(rawName);
  const descCell = mdTableCell(d.description);

  const lines = [
    "You are helping implement a new **Agent Forge** skill in this repository.",
    "",
    "## Required meta-skill",
    "",
    "1. **Read and follow** `@.claude/skills/authoring-agent-skills` (open `SKILL.md` in that folder). Use it as the single source of truth for skill anatomy, the YAML header at the top of `SKILL.md`, best practices, and the scaffold command.",
    "2. **Do not improvise** the folder layout or conventions—align with that meta-skill end-to-end.",
    "",
    "## Specification (from the human author)",
    "",
    "| Field | Value |",
    "|-------|-------|",
  ];
  if (rawName !== folder) {
    lines.push(
      "| **Skill name (as entered)** | `" + mdTableCell(rawName) + "` |",
    );
    lines.push(
      "| **Folder name** (use in every path and for `scaffold.ts`) | `" +
        folder +
        "` |",
    );
  } else {
    lines.push("| **Skill name** | `" + folder + "` |");
  }
  lines.push(
    "| **SKILL.md `description` (one-liner)** | " + descCell + " |",
    "",
    "### When to use this skill",
    "",
    d.whenToUse.trim() || "_(not specified)_",
    "",
    "### Workflow / steps the skill should encode",
    "",
    d.workflow.trim() || "_(not specified)_",
    "",
  );
  if (d.additionalNotes.trim()) {
    lines.push(
      "### Additional notes from author",
      "",
      d.additionalNotes.trim(),
      "",
    );
  }
  lines.push(
    "## Your tasks",
    "",
    "1. Follow `@.claude/skills/authoring-agent-skills` exactly to create `.claude/skills/" +
      folder +
      "/` with a complete `SKILL.md`. Use the **folder name** above (not spaces or free-form labels) so paths and the scaffold CLI stay valid. In the YAML header at the top of `SKILL.md`, set `name:` to **" +
      folder +
      "** (must match the folder slug exactly)—do not use the author’s free-form skill name if it differs.",
    "2. Decide whether optional `scripts/` (TypeScript) and/or `references/` folders would help; add them only when justified by the workflow and the meta-skill—do not add empty folders.",
    "3. Where appropriate, run `bun run .claude/skills/authoring-agent-skills/scripts/scaffold.ts " +
      folder +
      "` with the description from the spec (add quoted description per the meta-skill / your shell), then flesh out content.",
    "",
    "_End of prompt — paste the entire message above into your coding agent._",
  );
  return lines.join("\n");
}
