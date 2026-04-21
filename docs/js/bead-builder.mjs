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
  return String(s ?? "").replace(/\r\n?/g, "\n").replace(/\n/g, "\\n");
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
    parts.push(`--ac "${shellEscapeDoubleQuoted(line)}"`);
  }
  return parts.join(" ");
}

export function renderBeadBuilderHtml() {
  const typeOptions = BEAD_TYPES.map(
    (t) => '<option value="' + t + '"' + (t === "task" ? " selected" : "") + ">" + t + "</option>",
  ).join("");
  const priorityOptions = BEAD_PRIORITIES.map(
    (p) => '<option value="' + p + '"' + (p === "P2" ? " selected" : "") + ">" + p + "</option>",
  ).join("");
  return (
    '<p class="sb-lead" style="color:var(--text-muted);max-width:42rem;margin-bottom:1.5rem;line-height:1.55">' +
    "Describe the bead you want to file. On submit we build a ready-to-paste " +
    "<code>bd create</code> command and copy it to your clipboard — run it in a terminal that has <code>bd</code> on <code>PATH</code>." +
    "</p>" +
    '<div class="skill-form-card" id="bead-form-card">' +
    '<form id="bead-builder-form" class="skill-form" novalidate>' +
    '<div class="sb-field">' +
    '<label for="bb-title">Title <span class="sb-req">*</span></label>' +
    '<input id="bb-title" name="title" type="text" required placeholder="Short, imperative title (becomes --title)" autocomplete="off" />' +
    "</div>" +
    '<div class="sb-field">' +
    '<label for="bb-type">Type</label>' +
    '<select id="bb-type" name="type">' +
    typeOptions +
    "</select>" +
    '<span class="sb-hint">Choose <code>bug</code> for defects, <code>feature</code> for net-new capability, <code>chore</code> for maintenance, <code>task</code> otherwise.</span>' +
    "</div>" +
    '<div class="sb-field">' +
    '<label for="bb-priority">Priority</label>' +
    '<select id="bb-priority" name="priority">' +
    priorityOptions +
    "</select>" +
    '<span class="sb-hint">Follow <code>.claude/skills/beads-priority-assignment/SKILL.md</code>. Default <strong>P2</strong> when the rubric is silent.</span>' +
    "</div>" +
    '<div class="sb-field">' +
    '<label for="bb-repo">Repo</label>' +
    '<input id="bb-repo" name="repo" type="text" value="." placeholder="." autocomplete="off" />' +
    '<span class="sb-hint"><code>.</code> for the harness root; <code>./repos/&lt;name&gt;</code> for a registered sub-repo.</span>' +
    "</div>" +
    '<div class="sb-field">' +
    '<label for="bb-description">Description</label>' +
    '<textarea id="bb-description" name="description" rows="4" placeholder="Context, links, reproduction steps, etc. Newlines become \\n in the command."></textarea>' +
    "</div>" +
    '<div class="sb-field">' +
    '<label for="bb-ac">Acceptance criteria</label>' +
    '<textarea id="bb-ac" name="acceptanceCriteria" rows="4" placeholder="One per line. Each non-empty line becomes a separate --ac flag."></textarea>' +
    "</div>" +
    '<div class="sb-field">' +
    '<label for="bb-labels">Labels</label>' +
    '<input id="bb-labels" name="labels" type="text" placeholder="Comma-separated, e.g. dashboard,ui" autocomplete="off" />' +
    "</div>" +
    '<div class="sb-actions">' +
    '<button type="button" class="sb-clear" id="bb-clear">Clear form</button>' +
    '<button type="submit" class="sb-submit" id="bb-submit">' +
    '<span class="sb-submit-label">Build command &amp; copy</span>' +
    '<span class="sb-submit-spinner" aria-hidden="true"></span>' +
    "</button>" +
    "</div>" +
    "</form>" +
    "</div>" +
    '<div id="bb-modal" class="sb-modal" aria-hidden="true">' +
    '<div class="sb-modal-backdrop" tabindex="-1"></div>' +
    '<div class="sb-modal-panel" role="dialog" aria-modal="true" aria-labelledby="bb-modal-title">' +
    '<h2 id="bb-modal-title" class="sb-modal-title"></h2>' +
    '<p id="bb-modal-body" class="sb-modal-body"></p>' +
    '<p class="sb-modal-hint">Paste the command into a terminal where <code>bd</code> is installed. The new id will print on stdout.</p>' +
    '<div id="bb-modal-fallback" class="sb-modal-fallback" hidden>' +
    "<label>Copy manually:</label>" +
    '<textarea id="bb-modal-textarea" readonly rows="6"></textarea>' +
    "</div>" +
    '<button type="button" class="sb-modal-close" id="bb-modal-close">Close</button>' +
    "</div>" +
    "</div>"
  );
}

/** @param {HTMLElement} root */
export function wireBeadBuilder(root) {
  const form = root.querySelector("#bead-builder-form");
  const modal = root.querySelector("#bb-modal");
  const modalBody = root.querySelector("#bb-modal-body");
  const modalFallback = root.querySelector("#bb-modal-fallback");
  const modalTextarea = root.querySelector("#bb-modal-textarea");
  const modalClose = root.querySelector("#bb-modal-close");
  const modalTitle = root.querySelector("#bb-modal-title");
  const backdrop = modal ? modal.querySelector(".sb-modal-backdrop") : null;
  const submitBtn = root.querySelector("#bb-submit");
  const clearBtn = root.querySelector("#bb-clear");
  const card = root.querySelector("#bead-form-card");

  if (!form || !modal || !modalBody || !modalClose || !submitBtn || !modalTitle) return;

  if (clearBtn) {
    clearBtn.addEventListener("click", function () {
      closeModal();
      form.reset();
      form.classList.remove("is-submitting");
      submitBtn.disabled = false;
      const first = form.querySelector("#bb-title");
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
    const title = String(fd.get("title") || "").trim();
    if (!title) {
      form.reportValidity();
      return;
    }

    /** @type {BeadBuilderFormData} */
    const data = {
      title,
      type: String(fd.get("type") || "task"),
      priority: String(fd.get("priority") || "P2"),
      repo: String(fd.get("repo") || "."),
      description: String(fd.get("description") || ""),
      acceptanceCriteria: String(fd.get("acceptanceCriteria") || ""),
      labels: String(fd.get("labels") || ""),
    };

    const command = buildBdCreateCommand(data);
    submitBtn.disabled = true;
    form.classList.add("is-submitting");

    await new Promise(function (r) {
      setTimeout(r, 320);
    });

    let copied = false;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(command);
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
        "The <code>bd create</code> command is on your clipboard. <strong>Paste it into a terminal</strong> where <code>bd</code> is installed; it will print the new issue id.",
        command,
        "Copied to clipboard",
      );
    } else {
      openModal(
        "Clipboard was not available (browser permissions or non-secure context). <strong>Copy the command below</strong> and run it in your terminal.",
        command,
        "Copy this command",
      );
    }
  });
}
