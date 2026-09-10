/**
 * Hash routing for the dashboard SPA.
 *
 * Before this, nav clicks mutated a module variable and the URL never changed:
 * no back button, and nothing but `?view=` was linkable. Routes are now real
 * `#/route` URLs, and the seven legacy `?view=` values still resolve so old
 * bookmarks and cross-page links keep working.
 *
 * Pure functions only — the DOM wiring lives in `app.mjs`, so all of this is
 * testable without a browser.
 */

import type { IconName } from "./ds/Icon";

export interface RouteDefinition {
  id: string;
  label: string;
  icon: IconName;
  /** Nav section this route sits in. */
  group: "work" | "author";
  /** Sub-heading under the page title. */
  blurb: string;
  /** True when the view needs the local dev server to be useful. */
  devOnly?: boolean;
}

export const ROUTES = [
  {
    id: "dashboard",
    label: "Dashboard",
    icon: "gauge",
    group: "work",
    blurb: "Beads snapshot, the active forge run, and what is ready to pick up.",
  },
  {
    id: "issues",
    label: "All issues",
    icon: "list-checks",
    group: "work",
    blurb:
      "The Beads graph — epics, features, tasks, dependencies and acceptance criteria.",
  },
  {
    id: "epics",
    label: "Epics",
    icon: "stack",
    group: "work",
    blurb: "Initiatives and how far through their child issues they are.",
  },
  {
    id: "forge-run",
    label: "Forge run",
    icon: "flow-arrow",
    group: "work",
    blurb: "Research → plan → implement → ship, gated at every phase boundary.",
    devOnly: true,
  },
  {
    id: "commands",
    label: "Commands",
    icon: "terminal-window",
    group: "work",
    blurb: "Slash commands, workflow tiers, skills, agents and hooks.",
  },
  {
    id: "skill-builder",
    label: "Skill builder",
    icon: "sparkle",
    group: "author",
    blurb: "Compose an authoring prompt for a new skill.",
  },
  {
    id: "bead-builder",
    label: "Bead builder",
    icon: "plus-circle",
    group: "author",
    blurb: "Compose a bd create command with acceptance criteria and labels.",
  },
  {
    id: "insights",
    label: "Insights",
    icon: "chart-line",
    group: "work",
    blurb: "Throughput over time and the shape of recent activity.",
  },
  {
    id: "repos",
    label: "Repos & knowledge",
    icon: "books",
    group: "author",
    blurb:
      "Registered sub-repositories, knowledge YAML freshness, and parallel worktrees.",
    devOnly: true,
  },
] as const satisfies readonly RouteDefinition[];

export type RouteId = (typeof ROUTES)[number]["id"];

export const DEFAULT_ROUTE: RouteId = "dashboard";

const ROUTE_IDS = new Set<string>(ROUTES.map((route) => route.id));

export function isRouteId(value: string): value is RouteId {
  return ROUTE_IDS.has(value);
}

export function routeFor(id: RouteId): RouteDefinition {
  const route = ROUTES.find((candidate) => candidate.id === id);
  // Unreachable for a RouteId, but keeps the return type honest.
  return route ?? ROUTES[0];
}

/**
 * The route a hash points at.
 *
 * Unknown routes fall back to the dashboard rather than rendering nothing —
 * a stale link should land somewhere useful, not on a blank page.
 */
export function parseRoute(hash: string): RouteId {
  const raw = hash.replace(/^#/, "").replace(/^\//, "");
  const id = (raw.split(/[?/]/)[0] ?? "").trim();
  if (!id) return DEFAULT_ROUTE;
  return isRouteId(id) ? id : DEFAULT_ROUTE;
}

export function hrefFor(
  id: RouteId,
  options: { fromDocument?: boolean } = {},
): string {
  const hash = `#/${id}`;
  return options.fromDocument ? `index.html${hash}` : hash;
}

/** Legacy `?view=` values, mapped to the routes that replaced them. */
const LEGACY_VIEWS: Record<string, RouteId> = {
  dashboard: "dashboard",
  list: "issues",
  epics: "epics",
  commands: "commands",
  "skill-builder": "skill-builder",
  "bead-builder": "bead-builder",
  insights: "insights",
};

/**
 * The hash an old `index.html?view=…` link should become, or `null` when there
 * is nothing to redirect.
 *
 * Returns null when a hash is already present (the modern URL wins) and when
 * the query belongs to another page — `council.html`'s `?sourceType=`/`?source=`
 * and `?run=` contracts must pass through untouched.
 */
export function legacyRedirectFor(
  search: string,
  hash: string,
): string | null {
  if (hash.replace(/^#\/?/, "").trim() !== "") return null;

  const params = new URLSearchParams(search);
  const view = params.get("view");
  if (view === null) return null;

  const target = LEGACY_VIEWS[view];
  if (target === undefined) return null;

  params.delete("view");
  const rest = params.toString();
  return rest ? `${hrefFor(target)}?${rest}` : hrefFor(target);
}
