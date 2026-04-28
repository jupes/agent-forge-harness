// Agent Forge Dashboard — app (ES module; hybrid Preact islands + legacy HTML where noted).
import { issueIdCopyControlHtml } from "./issue-detail.mjs";
import { renderInsightsHtml, wireInsights } from "./insights.mjs";
import { applyInitiativeFilter, listEpics } from "./issues-selection.mjs";
import { createBridgeSelfTestVNode, mountIsland, unmountIsland } from "./preact-bridge.tsx";
import { h } from "preact";
import { BeadBuilderIsland } from "./islands/BeadBuilderIsland.tsx";
import { CommandsIsland } from "./islands/CommandsIsland.tsx";
import { IssuesViewsIsland } from "./islands/IssuesViewsIsland.tsx";
import { SkillBuilderIsland } from "./islands/SkillBuilderIsland.tsx";

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
/** All Issues view — kept in app state so Preact remounts do not reset filters. */
let listStatusFilter = "all";
let listSearchQuery = "";

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

/** Initiative `<select>` HTML for Insights (legacy string shell until Insights island owns it). */
function initiativeSelectHtmlForInsights() {
  const issues = (data && data.issues) || [];
  const epics = listEpics(issues);
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

function renderInsights() {
  if (!data) return '<div class="empty-state">Loading...</div>';
  return renderInsightsHtml(initiativeSelectHtmlForInsights());
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

function render() {
  syncNavRebuildWidget();
  const content = document.getElementById("content");
  const title = document.getElementById("view-title");
  const views = {
    dashboard: { label: "Dashboard", fn: null },
    list: { label: "All Issues", fn: null },
    epics: { label: "Epics", fn: renderEpics },
    commands: { label: "Commands", fn: null },
    "skill-builder": { label: "Skill builder", fn: null },
    "bead-builder": { label: "Bead builder", fn: null },
    insights: { label: "Insights", fn: renderInsights },
  };
  const v = views[activeView] || views.dashboard;
  if (title) title.textContent = v.label;
  if (content) {
    unmountIsland(content);
    if (activeView === "skill-builder") {
      content.innerHTML = "";
      mountIsland(content, h(SkillBuilderIsland, {}));
    } else if (activeView === "bead-builder") {
      content.innerHTML = "";
      mountIsland(content, h(BeadBuilderIsland, {}));
    } else if (activeView === "commands") {
      content.innerHTML = "";
      mountIsland(content, h(CommandsIsland, {}));
    } else if (activeView === "dashboard") {
      if (!data) {
        content.innerHTML = '<div class="empty-state">No data</div>';
      } else {
        content.innerHTML = "";
        mountIsland(
          content,
          h(IssuesViewsIsland, {
            variant: "dashboard",
            payload: data,
            initiativeFilter: initiativeFilter,
            onInitiativeChange: function (v) {
              initiativeFilter = v || "all";
              expandedIssueId = null;
              render();
            },
            expandedIssueId: expandedIssueId,
            onExpandedChange: function (id) {
              expandedIssueId = id;
              render();
            },
            listStatusFilter: listStatusFilter,
            listSearchQuery: listSearchQuery,
            onListStatusChange: function (v) {
              listStatusFilter = v;
              render();
            },
            onListSearchChange: function (v) {
              listSearchQuery = v;
              render();
            },
          }),
        );
      }
    } else if (activeView === "list") {
      if (!data) {
        content.innerHTML = '<div class="empty-state">No data</div>';
      } else {
        const issues = data.issues || [];
        const filtered = applyInitiativeFilter(issues, initiativeFilter).filter(function (i) {
          const matchStatus = listStatusFilter === "all" || i.status === listStatusFilter;
          const q = listSearchQuery.toLowerCase();
          const matchSearch = !q || i.title.toLowerCase().indexOf(q) !== -1 || i.id.toLowerCase().indexOf(q) !== -1;
          return matchStatus && matchSearch;
        });
        if (expandedIssueId && !filtered.some(function (i) {
          return i.id === expandedIssueId;
        })) {
          expandedIssueId = null;
        }
        content.innerHTML = "";
        mountIsland(
          content,
          h(IssuesViewsIsland, {
            variant: "list",
            payload: data,
            initiativeFilter: initiativeFilter,
            onInitiativeChange: function (v) {
              initiativeFilter = v || "all";
              expandedIssueId = null;
              render();
            },
            expandedIssueId: expandedIssueId,
            onExpandedChange: function (id) {
              expandedIssueId = id;
              render();
            },
            listStatusFilter: listStatusFilter,
            listSearchQuery: listSearchQuery,
            onListStatusChange: function (v) {
              listStatusFilter = v;
              render();
            },
            onListSearchChange: function (v) {
              listSearchQuery = v;
              render();
            },
          }),
        );
      }
    } else {
      content.innerHTML = v.fn();
      if (activeView === "insights") {
        const filtered = data ? { issues: applyInitiativeFilter(data.issues || [], initiativeFilter) } : null;
        void wireInsights(content, filtered);
      }
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

/**
 * Exercises Preact mount/unmount in Vite dev only (no visible UI).
 * @returns {void}
 */
function runPreactBridgeSelfTestIfDev() {
  const meta = typeof import.meta !== "undefined" ? import.meta : null;
  const env = meta && meta.env;
  if (!env || !env.DEV) return;
  const shell = document.createElement("div");
  shell.hidden = true;
  document.body.appendChild(shell);
  mountIsland(shell, createBridgeSelfTestVNode());
  unmountIsland(shell);
  document.body.removeChild(shell);
}

document.addEventListener("DOMContentLoaded", function () {
  wireIssueIdCopyDelegation();

  /** Deep-link SPA view from `index.html?view=<name>` (used by plan-review.html and bookmarks). */
  (function applyDashboardViewQuery() {
    try {
      var allowed = [
        "dashboard",
        "list",
        "epics",
        "commands",
        "skill-builder",
        "bead-builder",
        "insights",
      ];
      var params = new URLSearchParams(window.location.search);
      var q = params.get("view");
      if (q && allowed.indexOf(q) !== -1) {
        activeView = /** @type {typeof activeView} */ (q);
      }
      document.querySelectorAll("nav a[data-view]").forEach(function (a) {
        a.classList.toggle("active", /** @type {HTMLElement} */ (a).dataset.view === activeView);
      });
    } catch (e) {
      /* ignore malformed URL */
    }
  })();

  document.querySelectorAll("nav a[data-view]").forEach(function (a) {
    a.addEventListener("click", function (e) {
      e.preventDefault();
      setView(a.dataset.view);
    });
  });
  wireRebuildDataButton();
  runPreactBridgeSelfTestIfDev();
  loadData();
});
