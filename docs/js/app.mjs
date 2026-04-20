// Agent Forge Dashboard — app (ES module; imports issue-detail helpers for list expand).
import { toggleExpandedState, buildIssueDetailPanelHtml, issueIdCopyControlHtml } from "./issue-detail.mjs";
import { renderSkillBuilderHtml, wireSkillBuilder } from "./skill-builder.mjs";
import { renderInsightsHtml, wireInsights } from "./insights.mjs";

const STATUS_COLOR = {
  open: "#3dff9c",
  in_progress: "#ffe94d",
  closed: "#aeb8ce",
  blocked: "#ff4757",
};

/** Green checkmark inside the closed status pill only */
const STATUS_CLOSED_CHECK = "#34f097";

const TYPE_ICON = {
  epic: "⚡",
  feature: "✨",
  task: "📄",
  bug: "🐛",
  chore: "🔧",
};

function esc(str) {
  return String(str != null ? str : "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function typeCell(type) {
  const icon = TYPE_ICON[type] || "";
  const label = esc(type || "");
  if (!label && !icon) return "—";
  return (
    '<span class="type-pill">' +
    (icon ? '<span class="type-icon" aria-hidden="true">' + icon + "</span>" : "") +
    (label ? '<span class="type-label">' + label + "</span>" : "") +
    "</span>"
  );
}

const PRIORITY_COLOR = {
  critical: "#ff3838",
  high: "#ffb020",
  medium: "#6ec6ff",
  low: "#8aa4c8",
};

let data = null;
let activeView = "dashboard";
/** @type {string | null} */
let expandedIssueId = null;
/** Epic id, or "all" for no filter. Shared between Dashboard + All Issues. */
let initiativeFilter = "all";

async function loadData() {
  try {
    const res = await fetch("data/beads.json");
    if (!res.ok) throw new Error("HTTP " + res.status);
    data = await res.json();
    render();
  } catch (err) {
    document.getElementById("content").innerHTML =
      '<div class="empty-state">' +
      "<p>No data loaded. Run <code>bun run build-pages</code> to generate dashboard data.</p>" +
      '<p style="color:var(--text-muted);font-size:0.85rem;margin-top:0.5rem">' + err.message + "</p>" +
      "</div>";
  }
}

function statusBadge(status) {
  const s = String(status != null ? status : "");
  if (s === "closed") {
    const fg = STATUS_COLOR.closed;
    return (
      '<span class="badge badge-status-closed" style="display:inline-flex;align-items:center;gap:0.32em;background:' +
      fg +
      "26;color:" +
      fg +
      ";border:1px solid " +
      fg +
      '55"><span style="color:' +
      STATUS_CLOSED_CHECK +
      ';font-weight:800;line-height:1;font-size:1.05em" aria-hidden="true">\u2713</span><span>closed</span></span>'
    );
  }
  const color = STATUS_COLOR[s] || "#8aa4c8";
  return (
    '<span class="badge" style="background:' + color + "20;color:" + color + ";border:1px solid " + color + '40">' + esc(s) + "</span>"
  );
}

function priorityBadge(priority) {
  if (!priority) return "";
  const color = PRIORITY_COLOR[priority] || "#8aa4c8";
  return '<span class="badge" style="color:' + color + '">' + priority + "</span>";
}

/** Claimed or explicit in_progress — excludes “ready” open issues without assignee. */
function issuesInProgress(all) {
  const list = Array.isArray(all) ? all : [];
  return list.filter(function (i) {
    return i.status === "in_progress" || (i.status === "open" && i.assignee);
  });
}

function sortByUpdatedDesc(a, b) {
  return String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""));
}

/** Epics (aka initiatives), sorted by title for stable dropdown order. */
function listEpics() {
  const all = (data && data.issues) || [];
  return all
    .filter(function (i) { return i.type === "epic"; })
    .slice()
    .sort(function (a, b) {
      return String(a.title || "").localeCompare(String(b.title || ""));
    });
}

/**
 * Set of issue IDs belonging to an epic (the epic itself + all transitive
 * descendants via the `parent` field). Handles multi-level nesting
 * (epic → feature → task) and defends against accidental parent cycles.
 * @param {string} epicId
 * @returns {Set<string>}
 */
function computeInitiativeMembers(epicId) {
  const members = new Set();
  if (!epicId) return members;
  const all = (data && data.issues) || [];
  const childrenByParent = new Map();
  all.forEach(function (i) {
    if (!i.parent) return;
    let arr = childrenByParent.get(i.parent);
    if (!arr) { arr = []; childrenByParent.set(i.parent, arr); }
    arr.push(i.id);
  });
  const stack = [epicId];
  while (stack.length > 0) {
    const id = stack.pop();
    if (members.has(id)) continue;
    members.add(id);
    const kids = childrenByParent.get(id);
    if (kids) kids.forEach(function (k) { stack.push(k); });
  }
  return members;
}

/**
 * Apply current initiative filter to an issue list. Returns the list unchanged
 * when the filter is "all" or the selected epic no longer exists.
 * @template {{ id: string }} T
 * @param {T[]} issues
 * @returns {T[]}
 */
function applyInitiativeFilter(issues) {
  if (!Array.isArray(issues) || initiativeFilter === "all") return issues || [];
  const members = computeInitiativeMembers(initiativeFilter);
  if (members.size === 0) return issues;
  return issues.filter(function (i) { return members.has(i.id); });
}

/**
 * `<select>` for choosing an initiative. Emits into a shared module handler
 * so Dashboard + All Issues stay in sync on re-render.
 */
function initiativeSelectHtml() {
  const epics = listEpics();
  const selected = initiativeFilter;
  let html =
    '<label style="display:inline-flex;align-items:center;gap:0.45rem;color:var(--text-muted);font-size:0.85rem">' +
    '<span>Initiative</span>' +
    '<select id="filter-initiative" onchange="window.__dashboardSetInitiative(this.value)" ' +
    'style="padding:0.4rem 0.75rem;background:var(--surface-2);border:1px solid var(--border);color:var(--text);border-radius:6px;font-size:0.875rem;max-width:22rem">';
  html += '<option value="all"' + (selected === "all" ? " selected" : "") + ">All initiatives</option>";
  epics.forEach(function (e) {
    const label = e.title ? e.title + "  (" + e.id + ")" : e.id;
    html +=
      '<option value="' + esc(e.id) + '"' + (selected === e.id ? " selected" : "") + ">" + esc(label) + "</option>";
  });
  html += "</select></label>";
  return html;
}

/** Colspan for expandable issue tables (summary row + detail row). */
const ISSUE_TABLE_COLSPAN = 8;

/**
 * @param {unknown} iso
 * @returns {string}
 */
function formatIssueDate(iso) {
  const s = String(iso != null ? iso : "").trim();
  if (!s) return "—";
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return esc(s);
  return esc(
    d.toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }),
  );
}

/** Local label for payload `generatedAt` (sidebar); `title` holds raw ISO. */
function formatSnapshotGeneratedAt(iso) {
  const s = String(iso != null ? iso : "").trim();
  if (!s) return { label: "—", title: "" };
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return { label: s, title: s };
  const label = d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  return { label, title: s };
}

function syncNavRebuildWidget() {
  const el = document.getElementById("nav-data-generated-at");
  if (!el) return;
  if (!data || !data.generatedAt) {
    el.textContent = "Snapshot: not loaded";
    el.removeAttribute("title");
    return;
  }
  const { label, title } = formatSnapshotGeneratedAt(data.generatedAt);
  el.textContent = "Snapshot built: " + label;
  if (title) el.setAttribute("title", "ISO: " + title);
  else el.removeAttribute("title");
}

const EXPANDABLE_ISSUE_HEAD =
  '<thead><tr><th>ID</th><th>Title</th><th class="type-col">Type</th><th>Status</th><th>Priority</th><th>Repo</th><th class="date-col">Created</th><th class="date-col">Updated</th></tr></thead><tbody>';

/**
 * Expandable issue table (same UX as All Issues). Caller must run wireIssueListExpand on container.
 * @param {unknown[]} issues
 */
function renderExpandableIssueTable(issues, max) {
  const slice = (issues || []).slice(0, max);
  if (slice.length === 0) {
    return '<p style="color:var(--text-muted)">None.</p>';
  }
  let html = '<table class="issue-table issue-table-expandable">' + EXPANDABLE_ISSUE_HEAD;
  slice.forEach(function (i) {
    const isOpen = expandedIssueId === i.id;
    html +=
      '<tr class="issue-summary-row' +
      (isOpen ? " is-expanded" : "") +
      '" data-issue-id="' +
      esc(i.id) +
      '" role="button" tabindex="0" aria-expanded="' +
      (isOpen ? "true" : "false") +
      '">';
    html += "<td>" + issueIdCopyControlHtml(i.id) + "</td>";
    html += "<td>" + esc(i.title) + "</td>";
    html += '<td class="type-col">' + typeCell(i.type) + "</td>";
    html += "<td>" + statusBadge(i.status) + "</td>";
    html += "<td>" + priorityBadge(i.priority) + "</td>";
    html += "<td>" + esc(i.repo || "—") + "</td>";
    html += '<td class="date-col">' + formatIssueDate(i.createdAt) + "</td>";
    html += '<td class="date-col">' + formatIssueDate(i.updatedAt) + "</td>";
    html += "</tr>";
    html += '<tr class="issue-detail-gap"><td colspan="' + ISSUE_TABLE_COLSPAN + '">';
    html += '<div class="issue-detail-anim' + (isOpen ? " is-open" : "") + '">';
    html += '<div class="issue-detail-anim-inner">';
    html += buildIssueDetailPanelHtml(i, { comments: data.comments, deps: data.deps });
    html += "</div></div></td></tr>";
  });
  html += "</tbody></table>";
  return html;
}

function renderDashboard() {
  if (!data) return '<div class="empty-state">No data</div>';
  const { derived } = data;
  const openAllUnfiltered = (derived.byStatus || {}).open || [];
  const inProgressUnfiltered = (derived.byStatus || {}).in_progress || [];
  const readyUnfiltered = derived.ready || [];
  const blockedUnfiltered = derived.blocked || [];
  const closedUnfiltered = (derived.byStatus || {}).closed || [];

  const openAll = applyInitiativeFilter(openAllUnfiltered);
  const inProgressAll = applyInitiativeFilter(issuesInProgress(data.issues)).sort(sortByUpdatedDesc);
  const readyAll = applyInitiativeFilter(readyUnfiltered);
  const blockedAll = applyInitiativeFilter(blockedUnfiltered);
  const closedAll = applyInitiativeFilter(closedUnfiltered).slice().sort(sortByUpdatedDesc);

  const ready = readyAll.slice(0, 15);
  const inProgressIssues = inProgressAll.slice(0, 25);
  const blockedList = blockedAll.slice(0, 15);
  const closedRecent = closedAll.slice(0, 25);

  const open = openAll.length;
  const inProgressCount = initiativeFilter === "all" ? inProgressUnfiltered.length : inProgressAll.length;
  const closed = closedAll.length;
  const blocked = blockedAll.length;

  let html = '<div class="filter-row">' + initiativeSelectHtml() + "</div>";

  html += '<div class="stat-row">';
  html += '<div class="stat-card"><div class="stat-num" style="color:#3dff9c">' + open + '</div><div class="stat-label">Open</div></div>';
  html +=
    '<div class="stat-card"><div class="stat-num" style="color:#ffe94d">' + inProgressCount + '</div><div class="stat-label">In Progress</div></div>';
  html += '<div class="stat-card"><div class="stat-num" style="color:#ff4757">' + blocked + '</div><div class="stat-label">Blocked</div></div>';
  html += '<div class="stat-card"><div class="stat-num" style="color:#aeb8ce">' + closed + '</div><div class="stat-label">Closed</div></div>';
  html += "</div>";

  html +=
    '<p style="color:var(--text-muted);font-size:0.85rem;margin:0 0 1.25rem">Beads is the issue graph tracked with <code style="font-size:0.9em">bd</code> (epics, tasks, dependencies). This dashboard shows a built snapshot: status counts and lists of ready, in-progress, blocked, and recently closed work.</p>';

  html += "<h3>In Progress (" + inProgressAll.length + ")</h3>";
  html += renderExpandableIssueTable(inProgressIssues, 25);

  html += "<h3>Ready to Work (" + readyAll.length + ")</h3>";
  html += renderExpandableIssueTable(ready, 15);

  if (blockedAll.length > 0) {
    html += "<h3>Blocked (" + blockedAll.length + ")</h3>";
    html += renderExpandableIssueTable(blockedList, 15);
  }

  html += "<h3>Recently closed (" + closedAll.length + ")</h3>";
  html += renderExpandableIssueTable(closedRecent, 25);

  return html;
}

function renderList() {
  if (!data) return '<div class="empty-state">No data</div>';
  const filterEl = document.getElementById("filter-status");
  const searchEl = document.getElementById("search-input");
  const filter = filterEl ? filterEl.value : "all";
  const search = searchEl ? searchEl.value.toLowerCase() : "";

  const issues = applyInitiativeFilter(data.issues || []).filter(function (i) {
    const matchStatus = filter === "all" || i.status === filter;
    const matchSearch =
      !search || i.title.toLowerCase().indexOf(search) !== -1 || i.id.toLowerCase().indexOf(search) !== -1;
    return matchStatus && matchSearch;
  });

  if (expandedIssueId && !issues.some(function (i) {
    return i.id === expandedIssueId;
  })) {
    expandedIssueId = null;
  }

  let html = '<div class="filter-row" style="flex-wrap:wrap">';
  html +=
    '<input id="search-input" type="text" placeholder="Search..." oninput="window.__dashboardRender()" value="' +
    esc(search) +
    '" style="padding:0.4rem 0.75rem;background:var(--surface-2);border:1px solid var(--border);color:var(--text);border-radius:6px;font-size:0.875rem">';
  html +=
    '<select id="filter-status" onchange="window.__dashboardRender()" style="padding:0.4rem 0.75rem;background:var(--surface-2);border:1px solid var(--border);color:var(--text);border-radius:6px;font-size:0.875rem">';
  ["all", "open", "in_progress", "blocked", "closed"].forEach(function (s) {
    html += '<option value="' + s + '"' + (filter === s ? " selected" : "") + ">" + (s === "all" ? "All statuses" : s) + "</option>";
  });
  html += "</select>";
  html += initiativeSelectHtml();
  html += "</div>";

  html += '<p style="color:var(--text-muted);font-size:0.85rem;margin-bottom:0.75rem">' + issues.length + " issues</p>";
  html += '<table class="issue-table issue-table-expandable">' + EXPANDABLE_ISSUE_HEAD;
  issues.slice(0, 100).forEach(function (i) {
    const isOpen = expandedIssueId === i.id;
    html +=
      '<tr class="issue-summary-row' +
      (isOpen ? " is-expanded" : "") +
      '" data-issue-id="' +
      esc(i.id) +
      '" role="button" tabindex="0" aria-expanded="' +
      (isOpen ? "true" : "false") +
      '">';
    html += "<td>" + issueIdCopyControlHtml(i.id) + "</td>";
    html += "<td>" + esc(i.title) + "</td>";
    html += '<td class="type-col">' + typeCell(i.type) + "</td>";
    html += "<td>" + statusBadge(i.status) + "</td>";
    html += "<td>" + priorityBadge(i.priority) + "</td>";
    html += "<td>" + esc(i.repo || "—") + "</td>";
    html += '<td class="date-col">' + formatIssueDate(i.createdAt) + "</td>";
    html += '<td class="date-col">' + formatIssueDate(i.updatedAt) + "</td>";
    html += "</tr>";
    html += '<tr class="issue-detail-gap"><td colspan="' + ISSUE_TABLE_COLSPAN + '">';
    html += '<div class="issue-detail-anim' + (isOpen ? " is-open" : "") + '">';
    html += '<div class="issue-detail-anim-inner">';
    html += buildIssueDetailPanelHtml(i, { comments: data.comments, deps: data.deps });
    html += "</div></div></td></tr>";
  });
  html += "</tbody></table>";
  return html;
}

function renderEpics() {
  if (!data) return '<div class="empty-state">No data</div>';
  const epics = ((data.derived || {}).byType || {}).epic || [];
  if (epics.length === 0) {
    return '<div class="empty-state">No epics yet. Create one: <code>bd create --type epic --title "My Epic"</code></div>';
  }
  return epics
    .map(function (epic) {
      const children = (data.issues || []).filter(function (i) {
        return i.parent === epic.id;
      });
      const closedCount = children.filter(function (i) {
        return i.status === "closed";
      }).length;
      const pct = children.length > 0 ? Math.round((closedCount / children.length) * 100) : 0;

      let html = '<div class="epic-card">';
      html += '<div class="epic-header">';
      html += issueIdCopyControlHtml(epic.id);
      html += "<strong>" + esc(epic.title) + "</strong>";
      html += statusBadge(epic.status);
      if (epic.due) html += '<span style="color:var(--text-muted);font-size:0.8rem">Due: ' + epic.due.slice(0, 10) + "</span>";
      html += "</div>";
      html += '<div class="progress-bar-bg"><div class="progress-bar-fill" style="width:' + pct + '%"></div></div>';
      html +=
        '<div style="font-size:0.8rem;color:var(--text-muted);margin-top:0.25rem">' +
        closedCount +
        "/" +
        children.length +
        " tasks · " +
        pct +
        "%</div>";
      if (epic.description) {
        html += '<p style="color:var(--text-muted);font-size:0.875rem;margin-top:0.5rem">' + esc(epic.description.slice(0, 200)) + "</p>";
      }
      html += "</div>";
      return html;
    })
    .join("");
}

function renderCommands() {
  const commands = [
    ["/go [task]", "Adaptive router — auto-selects fix / feature / epic workflow"],
    ["/plan [idea]", "Codebase exploration + implementation plan"],
    ["/ship [msg]", "Quality gates → commit → push → PR"],
    ["/status", "Git state, ready tasks, blocked items, PR health"],
    ["/review [branch]", "Risk-tiered code review with AC trace matrix"],
    ["/triage", "Deadline management and capacity planning"],
    ["/ask [question]", "Query domain knowledge with staleness detection"],
    ["/sync-knowledge [repo|--all]", "Auto-generate per-repo knowledge YAML"],
  ];
  const workflows = [
    ["Fix", "≤3 files", "Explore → Build → Check → Ship (no plan)"],
    ["Feature", "&gt;3 files", "Plan → Approve → Build → Review → Ship"],
    ["Epic", "Multiple tasks", "Parallel batch execution with worktrees"],
  ];

  let html = "<table><thead><tr><th>Command</th><th>Description</th></tr></thead><tbody>";
  commands.forEach(function (c) {
    html += "<tr><td><code>" + esc(c[0]) + "</code></td><td>" + esc(c[1]) + "</td></tr>";
  });
  html += "</tbody></table><h3>Workflow Tiers</h3>";
  html += "<table><thead><tr><th>Workflow</th><th>Scope</th><th>Process</th></tr></thead><tbody>";
  workflows.forEach(function (w) {
    html += "<tr><td><strong>" + w[0] + "</strong></td><td>" + w[1] + "</td><td>" + w[2] + "</td></tr>";
  });
  html += "</tbody></table>";
  return html;
}

function renderSkillBuilder() {
  return renderSkillBuilderHtml();
}

function renderInsights() {
  if (!data) return '<div class="empty-state">Loading...</div>';
  return renderInsightsHtml(initiativeSelectHtml());
}

function setView(view) {
  activeView = view;
  if (view !== "list" && view !== "dashboard") expandedIssueId = null;
  document.querySelectorAll("nav a[data-view]").forEach(function (a) {
    a.classList.toggle("active", a.dataset.view === view);
  });
  render();
}

/** @type {ReturnType<typeof setTimeout> | null} */
let copyToastTimer = null;

/**
 * @param {string} message
 */
function showCopyToast(message) {
  const el = document.getElementById("copy-toast");
  if (!el) return;
  el.textContent = message;
  el.classList.add("is-visible");
  el.setAttribute("aria-hidden", "false");
  if (copyToastTimer) clearTimeout(copyToastTimer);
  copyToastTimer = setTimeout(function () {
    el.classList.remove("is-visible");
    el.setAttribute("aria-hidden", "true");
    copyToastTimer = null;
  }, 2600);
}

/**
 * @param {string} text
 * @returns {Promise<boolean>}
 */
async function copyTextToClipboard(text) {
  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through */
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    ta.style.top = "0";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

/**
 * Delegated clicks on `.issue-id-copy` inside `#content` (survives re-renders).
 */
function wireIssueIdCopyDelegation() {
  const root = document.getElementById("content");
  if (!root || root.dataset.copyDelegationWired === "1") return;
  root.dataset.copyDelegationWired = "1";
  root.addEventListener("click", function (e) {
    const btn = e.target && /** @type {HTMLElement} */ (e.target).closest(".issue-id-copy");
    if (!btn || !root.contains(btn)) return;
    e.preventDefault();
    e.stopPropagation();
    const text = btn.getAttribute("data-copy-text");
    if (!text) return;
    void copyTextToClipboard(text).then(function (ok) {
      showCopyToast(ok ? "Copied: " + text : "Could not copy — try selecting the ID manually.");
    });
  });
}

function wireIssueListExpand(root) {
  root.querySelectorAll(".issue-summary-row").forEach(function (row) {
    row.addEventListener("click", function (e) {
      if (e.target && /** @type {HTMLElement} */ (e.target).closest(".issue-id-copy")) return;
      const id = row.getAttribute("data-issue-id");
      if (!id) return;
      expandedIssueId = toggleExpandedState(expandedIssueId, id);
      render();
    });
    row.addEventListener("keydown", function (e) {
      if (e.key !== "Enter" && e.key !== " ") return;
      if (e.target && /** @type {HTMLElement} */ (e.target).closest(".issue-id-copy")) return;
      e.preventDefault();
      const id = row.getAttribute("data-issue-id");
      if (!id) return;
      expandedIssueId = toggleExpandedState(expandedIssueId, id);
      render();
    });
  });
  root.querySelectorAll(".issue-detail-close").forEach(function (btn) {
    btn.addEventListener("click", function (e) {
      e.stopPropagation();
      expandedIssueId = null;
      render();
    });
  });
}

function render() {
  syncNavRebuildWidget();
  const content = document.getElementById("content");
  const title = document.getElementById("view-title");
  const views = {
    dashboard: { label: "Dashboard", fn: renderDashboard },
    list: { label: "All Issues", fn: renderList },
    epics: { label: "Epics", fn: renderEpics },
    commands: { label: "Commands", fn: renderCommands },
    "skill-builder": { label: "Skill builder", fn: renderSkillBuilder },
    insights: { label: "Insights", fn: renderInsights },
  };
  const v = views[activeView] || views.dashboard;
  if (title) title.textContent = v.label;
  if (content) {
    content.innerHTML = v.fn();
    if (activeView === "list" || activeView === "dashboard") {
      wireIssueListExpand(content);
    }
    if (activeView === "skill-builder") {
      wireSkillBuilder(content);
    }
    if (activeView === "insights") {
      const filtered = data ? { issues: applyInitiativeFilter(data.issues || []) } : null;
      void wireInsights(content, filtered);
    }
  }
}

window.__dashboardRender = render;

window.__dashboardSetInitiative = function (value) {
  initiativeFilter = value || "all";
  expandedIssueId = null;
  render();
};

const REBUILD_PAGES_PATH = "/__agent-forge/rebuild-pages";

function wireRebuildDataButton() {
  const btn = document.getElementById("btn-rebuild-pages");
  if (!btn) return;
  btn.addEventListener("click", async function () {
    btn.disabled = true;
    var prev = btn.textContent;
    btn.textContent = "Refreshing…";
    try {
      var res = await fetch(REBUILD_PAGES_PATH, { method: "POST" });
      var body = {};
      try {
        body = await res.json();
      } catch {
        body = {};
      }
      if (!res.ok) {
        throw new Error((body && body.error) || res.statusText || "Request failed");
      }
      await loadData();
      render();
    } catch (err) {
      var msg = (err && err.message) || String(err) || "Unknown error";
      window.alert(
        "Could not refresh the data snapshot.\n\n" +
          msg +
          "\n\nThis button talks to the Vite dev server only. If you opened files directly or use GitHub Pages, run in the repo root:\n\n  bun run build-pages\n\nthen reload the page.",
      );
    } finally {
      btn.disabled = false;
      btn.textContent = prev;
    }
  });
}

document.addEventListener("DOMContentLoaded", function () {
  wireIssueIdCopyDelegation();
  document.querySelectorAll("nav a[data-view]").forEach(function (a) {
    a.addEventListener("click", function (e) {
      e.preventDefault();
      setView(a.dataset.view);
    });
  });
  wireRebuildDataButton();
  loadData();
});
