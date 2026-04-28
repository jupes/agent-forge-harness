// Plan review page — Preact island + sidebar snapshot / rebuild (mirrors index.html nav affordances).
import { h } from "preact";
import { PlanReviewIsland } from "./islands/PlanReviewIsland.tsx";
import { mountIsland } from "./preact-bridge.tsx";

const REBUILD_PAGES_PATH = "/__agent-forge/rebuild-pages";

function formatSnapshotLabel(iso) {
  const s = String(iso ?? "").trim();
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

async function syncPlanReviewNavSnapshot() {
  const el = document.getElementById("nav-data-generated-at");
  if (!el) return;
  try {
    const res = await fetch("data/beads.json");
    if (!res.ok) throw new Error("no data");
    const data = await res.json();
    const g = data && data.generatedAt;
    if (!g) {
      el.textContent = "Snapshot: not loaded";
      el.removeAttribute("title");
      return;
    }
    const { label, title } = formatSnapshotLabel(g);
    el.textContent = "Snapshot built: " + label;
    if (title) el.setAttribute("title", "ISO: " + title);
    else el.removeAttribute("title");
  } catch {
    el.textContent = "Snapshot: not loaded";
    el.removeAttribute("title");
  }
}

function wirePlanReviewRebuildButton() {
  const btn = document.getElementById("btn-rebuild-pages");
  if (!btn) return;
  btn.addEventListener("click", async function () {
    const prev = btn.textContent;
    btn.disabled = true;
    btn.textContent = "Refreshing…";
    try {
      const res = await fetch(REBUILD_PAGES_PATH, { method: "POST" });
      if (!res.ok) throw new Error("HTTP " + String(res.status));
      await syncPlanReviewNavSnapshot();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      window.alert(
        "Could not refresh the data snapshot.\n\n" +
          msg +
          "\n\nThis button talks to the Vite dev server only. Run in the repo root:\n\n  bun run build-pages\n\nthen reload.",
      );
    } finally {
      btn.disabled = false;
      btn.textContent = prev ?? "Refresh snapshot";
    }
  });
}

const root = document.getElementById("plan-review-root");
if (root) {
  mountIsland(root, h(PlanReviewIsland, {}));
}

void syncPlanReviewNavSnapshot();
wirePlanReviewRebuildButton();
