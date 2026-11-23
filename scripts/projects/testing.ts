import type { ProjectCatalog, ProjectRecord } from "../../types/projects";

export const FIXTURE_PROJECT_ID =
  "project-a5832fa0-7a21-403b-8184-44892f0d8d86";

/** Only for hermetic fixtures; production identities are minted by the store. */
export function projectFixture(
  workspace: string,
  overrides: Partial<ProjectRecord> = {},
): ProjectRecord {
  return {
    id: FIXTURE_PROJECT_ID,
    slug: "alpha",
    name: "Alpha",
    description: "Fixture project",
    icon: "A",
    pinned: false,
    archived: false,
    createdAt: "2026-10-21T00:00:00.000Z",
    updatedAt: "2026-10-21T00:00:00.000Z",
    workspaces: [
      { root: workspace, repositories: [workspace], epicIds: ["alpha-epic"] },
    ],
    ...overrides,
  };
}

export function projectCatalogFixture(workspace: string): ProjectCatalog {
  return { version: 1, revision: 1, projects: [projectFixture(workspace)] };
}
