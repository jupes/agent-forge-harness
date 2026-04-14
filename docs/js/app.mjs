// Agent Forge Dashboard — app (ES module; imports issue-detail helpers for list expand).
import { toggleExpandedState, buildIssueDetailPanelHtml, issueIdCopyControlHtml } from "./issue-detail.mjs";
import { renderSkillBuilderHtml, wireSkillBuilder } from "./skill-builder.mjs";

const STATUS_COLOR = {
  open: "#3fb950",
  in_progress: "#58a6ff",
  closed: "#8b949e",
  blocked: "#f78166",
};

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
  critical: "#f78166",
  high: "#f0a500",
  medium: "#58a6ff",
  low: "#8b949e",
};

let data = null;
let activeView = "dashboard";
/** @type {string | null} */
let expandedIssueId = null;

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
      '<p style="color:#8b949e;font-size:0.85rem;margin-top:0.5rem">' + err.message + "</p>" +
      "</div>";
  }
}

function statusBadge(status) {
  const color = STATUS_COLOR[status] || "#8b949e";
  return '<span class="badge" style="background:' + color + '20;color:' + color + ';border:1px solid ' + color + '40">' + status + "</span>";
}

function priorityBadge(priority) {
  if (!priority) return "";
  const color = PRIORITY_COLOR[priority] || "#8b949e";
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

const EXPANDABLE_ISSUE_HEAD =
  '<thead><tr><th>ID</th><th>Title</th><th class="type-col">Type</th><th>Status</th><th>Priority</th><th>Repo</th></tr></thead><tbody>';

/**
 * Expandable issue table (same UX as All Issues). Caller must run wireIssueListExpand on container.
 * @param {unknown[]} issues
 */
function renderExpandableIssueTable(issues, max) {
  const slice = (issues || []).slice(0, max);
  if (slice.length === 0) {
    return '<p style="color:#8b949e">None.</p>';
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
    html += "</tr>";
    html += '<tr class="issue-detail-gap"><td colspan="6">';
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
  const open = ((derived.byStatus || {}).open || []).length;
  const inProgressCount = ((derived.byStatus || {}).in_progress || []).length;
  const closed = ((derived.byStatus || {}).closed || []).length;
  const blocked = (derived.blocked || []).length;
  const readyAll = derived.ready || [];
  const ready = readyAll.slice(0, 15);
  const inProgressAll = issuesInProgress(data.issues).sort(sortByUpdatedDesc);
  const inProgressIssues = inProgressAll.slice(0, 25);
  const blockedAll = derived.blocked || [];
  const blockedList = blockedAll.slice(0, 15);
  const closedAll = ((derived.byStatus || {}).closed || []).slice().sort(sortByUpdatedDesc);
  const closedRecent = closedAll.slice(0, 25);

  let html = '<div class="stat-row">';
  html += '<div class="stat-card"><div class="stat-num" style="color:#3fb950">' + open + '</div><div class="stat-label">Open</div></div>';
  html +=
    '<div class="stat-card"><div class="stat-num" style="color:#58a6ff">' + inProgressCount + '</div><div class="stat-label">In Progress</div></div>';
  html += '<div class="stat-card"><div class="stat-num" style="color:#f78166">' + blocked + '</div><div class="stat-label">Blocked</div></div>';
  html += '<div class="stat-card"><div class="stat-num" style="color:#8b949e">' + closed + '</div><div class="stat-label">Closed</div></div>';
  html += "</div>";

  html +=
    '<p style="color:#8b949e;font-size:0.85rem;margin:0 0 1.25rem">Beads is the issue graph tracked with <code style="font-size:0.9em">bd</code> (epics, tasks, dependencies). This dashboard shows a built snapshot: status counts and lists of ready, in-progress, blocked, and recently closed work.</p>';

  html += "<h3>Ready to Work (" + readyAll.length + ")</h3>";
  html += renderExpandableIssueTable(ready, 15);

  html += "<h3>In Progress (" + inProgressAll.length + ")</h3>";
  html += renderExpandableIssueTable(inProgressIssues, 25);

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

  const issues = (data.issues || []).filter(function (i) {
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

  let html = '<div class="filter-row">';
  html +=
    '<input id="search-input" type="text" placeholder="Search..." oninput="window.__dashboardRender()" value="' +
    esc(search) +
    '" style="padding:0.4rem 0.75rem;background:#1c2333;border:1px solid #30363d;color:#e6edf3;border-radius:6px;font-size:0.875rem">';
  html +=
    '<select id="filter-status" onchange="window.__dashboardRender()" style="padding:0.4rem 0.75rem;background:#1c2333;border:1px solid #30363d;color:#e6edf3;border-radius:6px;font-size:0.875rem">';
  ["all", "open", "in_progress", "blocked", "closed"].forEach(function (s) {
    html += '<option value="' + s + '"' + (filter === s ? " selected" : "") + ">" + (s === "all" ? "All statuses" : s) + "</option>";
  });
  html += "</select></div>";

  html += '<p style="color:#8b949e;font-size:0.85rem;margin-bottom:0.75rem">' + issues.length + " issues</p>";
  html +=
    '<table class="issue-table issue-table-expandable"><thead><tr><th>ID</th><th>Title</th><th class="type-col">Type</th><th>Status</th><th>Priority</th><th>Repo</th></tr></thead><tbody>';
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
    html += "</tr>";
    html += '<tr class="issue-detail-gap"><td colspan="6">';
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
      if (epic.due) html += '<span style="color:#8b949e;font-size:0.8rem">Due: ' + epic.due.slice(0, 10) + "</span>";
      html += "</div>";
      html += '<div class="progress-bar-bg"><div class="progress-bar-fill" style="width:' + pct + '%"></div></div>';
      html +=
        '<div style="font-size:0.8rem;color:#8b949e;margin-top:0.25rem">' +
        closedCount +
        "/" +
        children.length +
        " tasks · " +
        pct +
        "%</div>";
      if (epic.description) {
        html += '<p style="color:#8b949e;font-size:0.875rem;margin-top:0.5rem">' + esc(epic.description.slice(0, 200)) + "</p>";
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
  const content = document.getElementById("content");
  const title = document.getElementById("view-title");
  const views = {
    dashboard: { label: "Dashboard", fn: renderDashboard },
    list: { label: "All Issues", fn: renderList },
    epics: { label: "Epics", fn: renderEpics },
    commands: { label: "Commands", fn: renderCommands },
    "skill-builder": { label: "Skill builder", fn: renderSkillBuilder },
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
  }
}

window.__dashboardRender = render;

const REBUILD_PAGES_PATH = "/__agent-forge/rebuild-pages";

function wireRebuildDataButton() {
  const btn = document.getElementById("btn-rebuild-pages");
  if (!btn) return;
  btn.addEventListener("click", async function () {
    btn.disabled = true;
    var prev = btn.textContent;
    btn.textContent = "Rebuilding…";
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
        "Could not rebuild dashboard data.\n\n" +
          msg +
          "\n\nThis button only works while `bun run dashboard` (Vite) is running.\nOtherwise run: bun run build-pages",
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
