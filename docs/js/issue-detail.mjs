/**
 * Pure helpers for the All Issues expandable detail panel.
 * Imported by app.mjs (browser) and by Bun unit tests.
 */

/** Escape text for HTML body contexts. */
export function escapeHtml(str) {
  return String(str != null ? str : "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Clickable issue id control: copies `data-copy-text` on click (wired in app.mjs).
 * @param {unknown} issueId
 * @returns {string}
 */
export function issueIdCopyControlHtml(issueId) {
  const id = String(issueId != null ? issueId : "");
  if (!id) return "";
  return (
    '<button type="button" class="issue-id-copy" data-copy-text="' +
    escapeHtml(id) +
    '" title="Copy issue ID"><code>' +
    escapeHtml(id) +
    "</code></button>"
  );
}

/**
 * Toggle which issue id is expanded in the list.
 * @param {string | null} currentExpandedId
 * @param {string} clickedIssueId
 * @returns {string | null}
 */
export function toggleExpandedState(currentExpandedId, clickedIssueId) {
  if (!clickedIssueId) return currentExpandedId;
  return currentExpandedId === clickedIssueId ? null : clickedIssueId;
}

/** @param {unknown[]} comments */
export function commentsForIssue(issueId, comments) {
  const list = Array.isArray(comments) ? comments : [];
  return list
    .filter(function (c) {
      return c && typeof c === "object" && c.issueId === issueId;
    })
    .slice()
    .sort(function (a, b) {
      return String(a.createdAt || "").localeCompare(String(b.createdAt || ""));
    });
}

/**
 * Best-effort branch names from worklogs (e.g. "Branch feat/foo", `` `feat/bar` ``).
 * @param {Array<{ body?: string }>} comments
 * @returns {string[]}
 */
export function workBranchesFromCommentBodies(comments) {
  const list = Array.isArray(comments) ? comments : [];
  const seen = new Set();
  const ordered = [];

  function normalizeBranchToken(s) {
    const t = String(s || "").trim();
    if (!t) return null;
    const m = t.match(/^((?:feat|fix|chore|epic)\/[a-z0-9._/-]+)/i);
    return m ? m[1] : null;
  }

  function add(raw) {
    const br = normalizeBranchToken(raw);
    if (!br || br.length > 200 || seen.has(br)) return;
    seen.add(br);
    ordered.push(br);
  }

  const patterns = [
    /\b[Bb]ranch\s+`([^`\n]+)`/g,
    /\b[Bb]ranch\s+([^\s`,.;:\n]+)/g,
    /`((?:feat|fix|chore|epic)\/[^`\s]+)`/gi,
  ];

  for (const c of list) {
    const text = String(c.body || "");
    for (let pi = 0; pi < patterns.length; pi++) {
      const p = patterns[pi];
      const r = new RegExp(p.source, p.flags);
      let m;
      while ((m = r.exec(text)) !== null) {
        add(m[1] || m[0]);
      }
    }
  }
  return ordered;
}

/** @param {unknown[]} deps */
export function depsTouchingIssue(issueId, deps) {
  const list = Array.isArray(deps) ? deps : [];
  return list.filter(function (d) {
    return d && typeof d === "object" && (d.from === issueId || d.to === issueId);
  });
}

/**
 * @param {Record<string, unknown>} issue
 * @param {{ comments?: unknown[]; deps?: unknown[] }} ctx
 * @returns {string} HTML (safe: user/issue strings passed through escapeHtml)
 */
export function buildIssueDetailPanelHtml(issue, ctx) {
  const ctxSafe = ctx || {};
  const comments = commentsForIssue(issue.id, ctxSafe.comments);
  const deps = depsTouchingIssue(issue.id, ctxSafe.deps);

  const rows = [];
  function addRow(label, value) {
    if (value === undefined || value === null || value === "") return;
    rows.push(
      "<div class=\"issue-detail-kv\"><dt>" +
        escapeHtml(label) +
        "</dt><dd>" +
        value +
        "</dd></div>",
    );
  }

  addRow("ID", issueIdCopyControlHtml(issue.id));
  addRow("Type", escapeHtml(String(issue.type ?? "")));
  addRow("Title", escapeHtml(String(issue.title ?? "")));
  addRow("Status", escapeHtml(String(issue.status ?? "")));
  if (issue.priority) addRow("Priority", escapeHtml(String(issue.priority)));
  if (issue.parent) addRow("Parent", issueIdCopyControlHtml(issue.parent));
  if (issue.repo) addRow("Repo", escapeHtml(String(issue.repo)));
  if (issue.due) addRow("Due", escapeHtml(String(issue.due)));
  if (issue.createdAt) addRow("Created", escapeHtml(String(issue.createdAt)));
  if (issue.updatedAt) addRow("Updated", escapeHtml(String(issue.updatedAt)));
  if (issue.owner) addRow("Owner", escapeHtml(String(issue.owner)));
  if (issue.assignee) addRow("Assignee (claimed)", escapeHtml(String(issue.assignee)));
  if (Array.isArray(issue.labels) && issue.labels.length) {
    addRow("Labels", issue.labels.map(function (l) { return escapeHtml(String(l)); }).join(", "));
  }
  if (Array.isArray(issue.ac) && issue.ac.length) {
    addRow(
      "AC",
      "<ul class=\"issue-detail-ac\">" +
        issue.ac.map(function (line) {
          return "<li>" + escapeHtml(String(line)) + "</li>";
        }).join("") +
        "</ul>",
    );
  }
  if (issue.estimate != null && issue.estimate !== "") addRow("Estimate (min)", escapeHtml(String(issue.estimate)));
  if (issue.spent != null && issue.spent !== "") addRow("Spent (min)", escapeHtml(String(issue.spent)));
  if (issue.closedBy) addRow("Closed by", escapeHtml(String(issue.closedBy)));
  if (issue.description) {
    addRow("Description / AC text", "<div class=\"issue-detail-prose\">" + escapeHtml(String(issue.description)) + "</div>");
  }

  const branches = workBranchesFromCommentBodies(comments);
  let branchesBlock = "";
  if (branches.length > 0) {
    branchesBlock =
      '<section class="issue-detail-section"><h5>Work branches (from comments)</h5><ul class="issue-detail-branches">' +
      branches
        .map(function (b) {
          return "<li><code>" + escapeHtml(b) + "</code></li>";
        })
        .join("") +
      "</ul></section>";
  }

  let commentsBlock = "";
  commentsBlock =
    '<section class="issue-detail-section"><h5>Comments</h5>' +
    (comments.length > 0
      ? '<ul class="issue-detail-comments">' +
        comments
          .map(function (c) {
            return (
              "<li><span class=\"issue-detail-meta\">" +
              escapeHtml(String(c.author || "")) +
              " · " +
              escapeHtml(String(c.createdAt || "")) +
              "</span><pre class=\"issue-detail-comment-body\">" +
              escapeHtml(String(c.body || "")) +
              "</pre></li>"
            );
          })
          .join("") +
        "</ul>"
      : '<p class="issue-detail-empty">No comments in this export.</p>') +
    "</section>";

  let depsBlock = "";
  if (deps.length > 0) {
    depsBlock =
      '<section class="issue-detail-section"><h5>Dependencies</h5><ul class="issue-detail-deps">' +
      deps
        .map(function (d) {
          var rel =
            d.from === issue.id
              ? "Blocked by"
              : "Blocks";
          var other = d.from === issue.id ? d.to : d.from;
          return (
            "<li><span class=\"issue-detail-dep-rel\">" +
            escapeHtml(rel) +
            "</span> <code>" +
            escapeHtml(String(other)) +
            "</code> <span class=\"issue-detail-dep-type\">(" +
            escapeHtml(String(d.type || "")) +
            ")</span></li>"
          );
        })
        .join("") +
      "</ul></section>";
  }

  return (
    '<div class="issue-detail-panel">' +
    '<div class="issue-detail-toolbar">' +
    '<span class="issue-detail-heading">Issue details</span>' +
    '<button type="button" class="issue-detail-close" aria-label="Close expanded issue">×</button>' +
    "</div>" +
    '<div class="issue-detail-dl-wrap">' +
    rows.join("") +
    "</div>" +
    branchesBlock +
    commentsBlock +
    depsBlock +
    "</div>"
  );
}
