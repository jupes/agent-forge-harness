/**
 * Pure state helpers for the dashboard shell.
 *
 * Kept apart from `app.tsx` so the rules that decide what renders — and what
 * a failed snapshot fetch may and may not hide — are testable without a DOM.
 */

import { type RouteId, routeFor } from "./router";

/**
 * Routes that read `docs/data/beads.json`.
 *
 * Everything else must render even when that fetch fails. The old shell got
 * this wrong: `loadData()`'s catch branch overwrote the content area and never
 * called `render()`, so a first-load deep link to Commands, Skill builder or
 * Bead builder — none of which touch Beads data — showed raw error text until
 * the user clicked something.
 */
const SNAPSHOT_ROUTES = new Set<RouteId>([
  "dashboard",
  "issues",
  "epics",
  "insights",
]);

export function needsSnapshot(route: RouteId): boolean {
  return SNAPSHOT_ROUTES.has(route);
}

export interface SnapshotLabel {
  label: string;
  /** Raw ISO string for the title attribute; empty when unknown. */
  iso: string;
}

/** Sidebar snapshot line: local time to read, ISO on hover. */
export function snapshotLabelFor(generatedAt: string | null): SnapshotLabel {
  const raw = String(generatedAt ?? "").trim();
  if (!raw) return { label: "Snapshot: not loaded", iso: "" };

  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    return { label: `Snapshot built: ${raw}`, iso: raw };
  }

  return {
    label: `Snapshot built: ${parsed.toLocaleString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })}`,
    iso: raw,
  };
}

export interface PageHeading {
  title: string;
  blurb: string;
}

export function pageTitleFor(route: RouteId): PageHeading {
  const definition = routeFor(route);
  return { title: definition.label, blurb: definition.blurb };
}
