import { createHash } from "node:crypto";
import type { ProjectRecord } from "../../types/projects";
import { workspaceKey } from "../projects/scope";

/** Membership authority only. Presentation/default changes must not revoke an admitted Shift. */
export function projectShiftScopeHash(project: ProjectRecord): string {
  return createHash("sha256").update(JSON.stringify({id: project.id, slug: project.slug,
    workspaces: project.workspaces.map(scope => ({root: workspaceKey(scope.root), repositories: scope.repositories.map(workspaceKey).sort(), epicIds: [...scope.epicIds].sort()})).sort((left,right) => left.root.localeCompare(right.root)),
  })).digest("hex");
}
