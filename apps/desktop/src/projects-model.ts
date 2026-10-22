import type {
  ProjectSummary,
  ProjectsHome,
} from "../../../types/project-summary";
import type { ProjectRecord } from "../../../types/projects";
import { desktopHref, type ProjectDestination } from "./navigation";

export function openProject(
  id: string,
  destination: ProjectDestination = "overview",
): string {
  return desktopHref({ destination, projectId: id, selection: null });
}

export function projectCards(
  home: ProjectsHome,
  filter: "active" | "archived" | "all",
  search: string,
): { project: ProjectRecord; summary: ProjectSummary | undefined }[] {
  const query = search.trim().toLocaleLowerCase();
  const summaries = new Map(
    home.summaries.map((item) => [item.projectId, item]),
  );
  return home.catalog.projects
    .filter(
      (project) =>
        (filter === "all" || project.archived === (filter === "archived")) &&
        `${project.name} ${project.description}`
          .toLocaleLowerCase()
          .includes(query),
    )
    .map((project) => ({ project, summary: summaries.get(project.id) }))
    .sort(
      (a, b) =>
        Number(b.project.pinned) - Number(a.project.pinned) ||
        (b.summary?.needsYou.length ?? 0) - (a.summary?.needsYou.length ?? 0) ||
        (Date.parse(b.summary?.lastActivity ?? "") || 0) -
          (Date.parse(a.summary?.lastActivity ?? "") || 0) ||
        a.project.name.localeCompare(b.project.name) ||
        a.project.id.localeCompare(b.project.id),
    );
}
