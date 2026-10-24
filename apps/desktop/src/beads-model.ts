import type { ProjectBead } from "../../../types/project-beads";
export const BEAD_VIEWS = [
  ["ready", "Ready"],
  ["in_progress", "In progress"],
  ["blocked", "Blocked"],
  ["closed", "Recently closed"],
  ["all", "All"],
  ["epics", "Epics"],
] as const;
export type BeadView = (typeof BEAD_VIEWS)[number][0];
export interface BeadFilters {
  view: BeadView;
  query: string;
  type: string;
  priority: string;
  status: string;
  queue: string;
  label: string;
  epic: string;
  assignee: string;
  group: "none" | "epic" | "status";
}
export const newBeadFilters = (): BeadFilters => ({
  view: "ready",
  query: "",
  type: "",
  priority: "",
  status: "",
  queue: "",
  label: "",
  epic: "",
  assignee: "",
  group: "none",
});
export function beadAncestors(
  bead: ProjectBead,
  rows: readonly ProjectBead[],
): string[] {
  const byId = new Map(rows.map((item) => [item.id, item])),
    seen = new Set([bead.id]),
    parents: string[] = [];
  let parent = bead.parent;
  while (parent && !seen.has(parent)) {
    seen.add(parent);
    parents.push(parent);
    parent = byId.get(parent)?.parent ?? null;
  }
  return parents;
}
export function filterBeads(
  rows: readonly ProjectBead[],
  filters: BeadFilters,
): ProjectBead[] {
  const query = filters.query.trim().toLocaleLowerCase();
  const result = rows.filter(
    (bead) =>
      (filters.view === "all" ||
        (filters.view === "ready"
          ? bead.ready
          : filters.view === "epics"
            ? bead.type === "epic"
            : filters.view === "blocked"
              ? bead.status !== "closed" && bead.blocked
              : bead.status === filters.view)) &&
      (!query ||
        `${bead.id}\n${bead.title}`.toLocaleLowerCase().includes(query)) &&
      (!filters.type || bead.type === filters.type) &&
      (!filters.priority || String(bead.priority) === filters.priority) &&
      (!filters.status || bead.status === filters.status) &&
      (!filters.queue || bead.queue === filters.queue) &&
      (!filters.label || bead.labels.includes(filters.label)) &&
      (!filters.assignee || bead.assignee === filters.assignee) &&
      (!filters.epic ||
        bead.id === filters.epic ||
        beadAncestors(bead, rows).includes(filters.epic)),
  );
  return filters.view === "closed"
    ? result.sort(
        (a, b) =>
          b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id),
      )
    : result;
}
export function beadGroups(
  rows: readonly ProjectBead[],
  group: BeadFilters["group"],
  all: readonly ProjectBead[] = rows,
): { title: string; beads: ProjectBead[] }[] {
  if (group === "none") return [{ title: "Beads", beads: [...rows] }];
  const byId = new Map(all.map((item) => [item.id, item])),
    groups = new Map<string, ProjectBead[]>();
  for (const bead of rows) {
    const epic = beadAncestors(bead, all).find(
      (id) => byId.get(id)?.type === "epic",
    );
    const title =
      group === "status"
        ? bead.status
        : (epic ?? (bead.type === "epic" ? bead.id : "No epic"));
    const items = groups.get(title) ?? [];
    items.push(bead);
    groups.set(title, items);
  }
  return [...groups].map(([title, beads]) => ({ title, beads }));
}
export function epicProgress(rows: readonly ProjectBead[], id: string) {
  const children = rows.filter(
    (bead) => bead.id !== id && beadAncestors(bead, rows).includes(id),
  );
  return {
    total: children.length,
    closed: children.filter((bead) => bead.status === "closed").length,
    blocked: children.filter((bead) => bead.status !== "closed" && bead.blocked)
      .length,
    states: [...new Set(children.map((bead) => bead.status))].map((status) => ({
      status,
      count: children.filter((bead) => bead.status === status).length,
    })),
  };
}
