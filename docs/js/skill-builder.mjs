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
    lines.push("| **Skill name (as entered)** | `" + mdTableCell(rawName) + "` |");
    lines.push("| **Folder name** (use in every path and for `scaffold.ts`) | `" + folder + "` |");
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
    lines.push("### Additional notes from author", "", d.additionalNotes.trim(), "");
  }
  lines.push(
    "## Your tasks",
    "",
    "1. Follow `@.claude/skills/authoring-agent-skills` exactly to create `.claude/skills/" + folder + "/` with a complete `SKILL.md`. Use the **folder name** above (not spaces or free-form labels) so paths and the scaffold CLI stay valid. In the YAML header at the top of `SKILL.md`, set `name:` to **" + folder + "** (must match the folder slug exactly)—do not use the author’s free-form skill name if it differs.",
    "2. Decide whether optional `scripts/` (TypeScript) and/or `references/` folders would help; add them only when justified by the workflow and the meta-skill—do not add empty folders.",
    "3. Where appropriate, run `bun run .claude/skills/authoring-agent-skills/scripts/scaffold.ts " + folder + "` with the description from the spec (add quoted description per the meta-skill / your shell), then flesh out content.",
    "",
    "_End of prompt — paste the entire message above into your coding agent._",
  );
  return lines.join("\n");
}

export function renderSkillBuilderHtml() {
  return (
    '<p class="sb-lead" style="color:var(--text-muted);max-width:42rem;margin-bottom:1.5rem;line-height:1.55">' +
    "Describe the skill you want. On submit we build a single prompt for your agent (including a directive to use " +
    "<code>@.claude/skills/authoring-agent-skills</code>) and copy it to the clipboard." +
    "</p>" +
    '<div class="skill-form-card" id="skill-form-card">' +
    '<form id="skill-builder-form" class="skill-form" novalidate>' +
    '<div class="sb-field">' +
    '<label for="sb-skill-name">Skill name <span class="sb-req">*</span></label>' +
    '<input id="sb-skill-name" name="skillName" type="text" required placeholder="e.g. deploy-staging" autocomplete="off" />' +
    '<span class="sb-hint">Becomes a kebab-case folder under <code>.claude/skills/</code> in the prompt (spaces and punctuation are normalized).</span>' +
    "</div>" +
    '<div class="sb-field">' +
    '<label for="sb-description">One-line description <span class="sb-req">*</span></label>' +
    '<input id="sb-description" name="description" type="text" required placeholder="Short one-line summary (top of SKILL.md)" />' +
    "</div>" +
    '<div class="sb-field">' +
    '<label for="sb-when">When to use this skill</label>' +
    '<textarea id="sb-when" name="whenToUse" rows="3" placeholder="Triggers, contexts, or roles that should load this skill…"></textarea>' +
    "</div>" +
    '<div class="sb-field">' +
    '<label for="sb-workflow">Workflow / steps to encode</label>' +
    '<textarea id="sb-workflow" name="workflow" rows="6" placeholder="Numbered or bulleted steps you want the agent to follow…"></textarea>' +
    "</div>" +
    '<div class="sb-field">' +
    '<label for="sb-notes">Additional constraints or notes</label>' +
    '<textarea id="sb-notes" name="additionalNotes" rows="3" placeholder="e.g. JSON output from scripts, idempotency, error handling…"></textarea>' +
    "</div>" +
    '<div class="sb-actions">' +
    '<button type="button" class="sb-clear" id="sb-clear">Clear form</button>' +
    '<button type="submit" class="sb-submit" id="sb-submit">' +
    '<span class="sb-submit-label">Generate prompt &amp; copy</span>' +
    '<span class="sb-submit-spinner" aria-hidden="true"></span>' +
    "</button>" +
    "</div>" +
    "</form>" +
    "</div>" +
    '<div id="sb-modal" class="sb-modal" aria-hidden="true">' +
    '<div class="sb-modal-backdrop" tabindex="-1"></div>' +
    '<div class="sb-modal-panel" role="dialog" aria-modal="true" aria-labelledby="sb-modal-title">' +
    '<h2 id="sb-modal-title" class="sb-modal-title"></h2>' +
    '<p id="sb-modal-body" class="sb-modal-body"></p>' +
    '<p class="sb-modal-hint">Paste that prompt into your coding agent so it can create the skill using the authoring meta-skill.</p>' +
    '<div id="sb-modal-fallback" class="sb-modal-fallback" hidden>' +
    "<label>Copy manually:</label>" +
    '<textarea id="sb-modal-textarea" readonly rows="8"></textarea>' +
    "</div>" +
    '<button type="button" class="sb-modal-close" id="sb-modal-close">Close</button>' +
    "</div>" +
    "</div>"
  );
}

/** @param {HTMLElement} root */
export function wireSkillBuilder(root) {
  const form = root.querySelector("#skill-builder-form");
  const modal = root.querySelector("#sb-modal");
  const modalBody = root.querySelector("#sb-modal-body");
  const modalFallback = root.querySelector("#sb-modal-fallback");
  const modalTextarea = root.querySelector("#sb-modal-textarea");
  const modalClose = root.querySelector("#sb-modal-close");
  const modalTitle = root.querySelector("#sb-modal-title");
  const backdrop = root.querySelector(".sb-modal-backdrop");
  const submitBtn = root.querySelector("#sb-submit");
  const clearBtn = root.querySelector("#sb-clear");
  const card = root.querySelector("#skill-form-card");

  if (!form || !modal || !modalBody || !modalClose || !submitBtn || !modalTitle) return;

  if (clearBtn) {
    clearBtn.addEventListener("click", function () {
      closeModal();
      form.reset();
      form.classList.remove("is-submitting");
      submitBtn.disabled = false;
      const first = form.querySelector("#sb-skill-name");
      if (first instanceof HTMLElement) first.focus();
    });
  }

  function closeModal() {
    modal.classList.remove("is-open");
    modal.setAttribute("aria-hidden", "true");
    if (modalFallback) modalFallback.hidden = true;
  }

  /**
   * @param {string} message
   * @param {string | null} fallbackText
   * @param {string} [titleText]
   */
  function openModal(message, fallbackText, titleText) {
    modalTitle.textContent = titleText || "Copied to clipboard";
    modalBody.innerHTML = message;
    if (fallbackText && modalFallback && modalTextarea) {
      modalFallback.hidden = false;
      modalTextarea.value = fallbackText;
      modalTextarea.select();
    } else if (modalFallback) {
      modalFallback.hidden = true;
    }
    modal.classList.add("is-open");
    modal.setAttribute("aria-hidden", "false");
    requestAnimationFrame(function () {
      modalClose.focus();
    });
  }

  modalClose.addEventListener("click", closeModal);
  if (backdrop) backdrop.addEventListener("click", closeModal);
  modal.addEventListener("keydown", function (e) {
    if (e.key === "Escape") closeModal();
  });

  form.addEventListener("submit", async function (e) {
    e.preventDefault();
    const fd = new FormData(form);
    const skillName = String(fd.get("skillName") || "").trim();
    const description = String(fd.get("description") || "").trim();
    if (!skillName || !description) {
      form.reportValidity();
      return;
    }

    /** @type {SkillBuilderFormData} */
    const data = {
      skillName,
      description,
      whenToUse: String(fd.get("whenToUse") || ""),
      workflow: String(fd.get("workflow") || ""),
      additionalNotes: String(fd.get("additionalNotes") || ""),
    };

    const prompt = buildAuthoringPrompt(data);
    submitBtn.disabled = true;
    form.classList.add("is-submitting");

    await new Promise(function (r) {
      setTimeout(r, 480);
    });

    let copied = false;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(prompt);
        copied = true;
      }
    } catch {
      copied = false;
    }

    form.classList.remove("is-submitting");
    submitBtn.disabled = false;

    if (card) {
      card.classList.add("is-success-flash");
      card.addEventListener(
        "animationend",
        function onAnim() {
          card.removeEventListener("animationend", onAnim);
          card.classList.remove("is-success-flash");
        },
        { once: true },
      );
    }

    if (copied) {
      openModal(
        "The full authoring prompt is on your clipboard. <strong>Give it to your agent</strong> in Claude Code, Cursor, or any tool that can read the repo and follow <code>@.claude/skills/authoring-agent-skills</code>.",
        null,
        "Copied to clipboard",
      );
    } else {
      openModal(
        "Clipboard was not available (browser permissions or non-secure context). <strong>Copy the prompt below</strong> and give it to your agent.",
        prompt,
        "Copy this prompt",
      );
    }
  });
}
