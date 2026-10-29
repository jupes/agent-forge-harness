import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import type { ProjectCatalog, ProjectRecord } from "../../types/projects";
import { projectFixture } from "../../scripts/projects/testing";
import { beta, catalogFile, seedProjects, workspace } from "./project-fixtures";

export function seedCouncilProject(): ProjectRecord {
  seedProjects();
  const alpha = projectFixture(workspace, { id: `project-${randomUUID()}` });
  const catalog: ProjectCatalog = {
    version: 1,
    revision: 1,
    projects: [alpha, beta],
  };
  writeFileSync(catalogFile, JSON.stringify(catalog));
  return alpha;
}
