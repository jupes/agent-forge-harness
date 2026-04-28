/**
 * Pure helpers for initiative filtering and issue ordering (dashboard + All Issues).
 * Shared by docs/js/app.mjs and Preact islands.
 */

import { escapeHtml } from "./issue-detail.mjs";

/**
 * @param {Array<{ id: string; title?: string; type?: string; parent?: string }>} issues
 */
export function listEpics(issues) {
  const all = Array.isArray(issues) ? issues : [];
  return all
    .filter(function (i) {
      return i.type === "epic";
    })
    .slice()
    .sort(function (a, b) {
      return String(a.title || "").localeCompare(String(b.title || ""));
    });
}

/**
 * @param {Array<{ id: string; parent?: string }>} issues
 * @param {string} epicId
 * @returns {Set<string>}
 */
export function computeInitiativeMembers(issues, epicId) {
  const members = new Set();
  if (!epicId) return members;
  const all = Array.isArray(issues) ? issues : [];
  const childrenByParent = new Map();
  all.forEach(function (i) {
    if (!i.parent) return;
    let arr = childrenByParent.get(i.parent);
    if (!arr) {
      arr = [];
      childrenByParent.set(i.parent, arr);
    }
    arr.push(i.id);
  });
  const stack = [epicId];
  while (stack.length > 0) {
    const id = stack.pop();
    if (members.has(id)) continue;
    members.add(id);
    const kids = childrenByParent.get(id);
    if (kids)
      kids.forEach(function (k) {
        stack.push(k);
      });
  }
  return members;
}

/**
 * @template {{ id: string }} T
 * @param {T[]} issues
 * @param {string} initiativeFilter
 * @returns {T[]}
 */
export function applyInitiativeFilter(issues, initiativeFilter) {
  if (!Array.isArray(issues) || initiativeFilter === "all") return issues || [];
  const members = computeInitiativeMembers(issues, initiativeFilter);
  if (members.size === 0) return issues;
  return issues.filter(function (i) {
    return members.has(i.id);
  });
}

/** @param {Array<{ status?: string; assignee?: string }>} issues */
export function issuesInProgress(issues) {
  const list = Array.isArray(issues) ? issues : [];
  return list.filter(function (i) {
    return i.status === "in_progress" || (i.status === "open" && i.assignee);
  });
}

export function sortByUpdatedDesc(a, b) {
  return String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""));
}

/**
 * @param {unknown} iso
 * @returns {string} HTML-safe fragment (uses escapeHtml)
 */
export function formatIssueDate(iso) {
  const s = String(iso != null ? iso : "").trim();
  if (!s) return "—";
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return escapeHtml(s);
  return escapeHtml(
    d.toLocaleString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }),
  );
}
