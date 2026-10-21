import type { IconName } from "../../../docs/js/ds/Icon";

export const GLOBAL_DESTINATIONS = [
  { id: "projects", label: "Projects", icon: "squares-four" },
  { id: "inbox", label: "Inbox", icon: "tray" },
  { id: "providers", label: "Providers & usage", icon: "gauge" },
  { id: "smiths", label: "Smiths", icon: "users-three" },
  { id: "app-settings", label: "Settings", icon: "gear" },
] as const satisfies readonly { id: string; label: string; icon: IconName }[];

export const PROJECT_DESTINATIONS = [
  { id: "keeper", label: "Forge Keeper", icon: "sparkle" },
  { id: "overview", label: "Overview", icon: "gauge" },
  { id: "sessions", label: "Sessions", icon: "terminal-window" },
  { id: "beads", label: "Beads", icon: "list-checks" },
  { id: "workbench", label: "Workbench", icon: "hammer" },
  { id: "runs", label: "Runs", icon: "flow-arrow" },
  { id: "reviews", label: "Reviews", icon: "users-three" },
  { id: "activity", label: "Activity", icon: "list-bullets" },
  { id: "project-settings", label: "Settings", icon: "gear" },
] as const satisfies readonly { id: string; label: string; icon: IconName }[];

export type GlobalDestination = (typeof GLOBAL_DESTINATIONS)[number]["id"];
export type ProjectDestination = (typeof PROJECT_DESTINATIONS)[number]["id"];
export type DesktopSelection = {
  kind: "bead" | "session" | "run" | "event";
  id: string;
};
export interface DesktopRoute {
  destination: GlobalDestination | ProjectDestination;
  projectId: string | null;
  selection: DesktopSelection | null;
}

const HOME: DesktopRoute = {
  destination: "projects",
  projectId: null,
  selection: null,
};
const identifier = (value: string | null): value is string =>
  value !== null &&
  value.trim().length > 0 &&
  value.length <= 256 &&
  [...value].every(
    (character) =>
      character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127,
  );

/** Hash-only desktop routing: object ids, never display names or row indexes. */
export function desktopRoute(hash: string): DesktopRoute {
  try {
    const url = new URL(hash.replace(/^#/, ""), "http://127.0.0.1");
    const parts = url.pathname.split("/").slice(1).map(decodeURIComponent);
    if (parts[0] !== "desktop") return HOME;
    const scoped = parts[1] === "project";
    const destination = scoped ? parts[3] : parts[1];
    const projectId = scoped
      ? (parts[2] ?? null)
      : url.searchParams.get("project");
    const destinations = scoped ? PROJECT_DESTINATIONS : GLOBAL_DESTINATIONS;
    if (
      parts.length !== (scoped ? 4 : 2) ||
      !destinations.some((entry) => entry.id === destination) ||
      (scoped && !identifier(projectId))
    )
      return HOME;
    const kind = url.searchParams.get("selectionKind");
    const id = url.searchParams.get("selectionId");
    const selection: DesktopSelection | null =
      identifier(id) &&
      (kind === "bead" ||
        kind === "session" ||
        kind === "run" ||
        kind === "event")
        ? { kind, id }
        : null;
    return {
      // justification: destination was matched against one of the two closed tables above.
      destination: destination as DesktopRoute["destination"],
      projectId: identifier(projectId) ? projectId : null,
      selection,
    };
  } catch {
    return HOME;
  }
}

export function desktopHref(route: DesktopRoute): string {
  const global = GLOBAL_DESTINATIONS.some(
    (entry) => entry.id === route.destination,
  );
  if (!global && !identifier(route.projectId)) return "#/desktop/projects";
  const path = global
    ? `/desktop/${route.destination}`
    : `/desktop/project/${encodeURIComponent(route.projectId!)}/${route.destination}`;
  const query = new URLSearchParams();
  if (global && route.projectId !== null) query.set("project", route.projectId);
  if (route.selection) {
    query.set("selectionKind", route.selection.kind);
    query.set("selectionId", route.selection.id);
  }
  return `#${path}${query.size ? `?${query}` : ""}`;
}

export function navigateGlobal(
  route: DesktopRoute,
  destination: GlobalDestination,
): DesktopRoute {
  return { ...route, destination };
}
export function navigateProject(
  route: DesktopRoute,
  destination: ProjectDestination,
): DesktopRoute {
  return route.projectId === null
    ? navigateGlobal(route, "projects")
    : { ...route, destination };
}
