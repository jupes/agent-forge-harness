import type { BeadsIssue } from "../../types/beads";
import type { ProjectRecord } from "../../types/projects";

/** Compare already canonical ledger paths without reading the filesystem. */
export function workspaceKey(path: string): string {
  const value = path.replaceAll("\\", "/").replace(/\/+$/, "");
  return /^[a-z]:\//i.test(value) ? value.toLowerCase() : value;
}

function uniqueIssues(issues: readonly BeadsIssue[]): Map<string, BeadsIssue> {
  const byId = new Map<string, BeadsIssue>();
  const conflicted = new Set<string>();
  for (const issue of issues) {
    const previous = byId.get(issue.id);
    if (previous && JSON.stringify(previous) !== JSON.stringify(issue))
      conflicted.add(issue.id);
    else byId.set(issue.id, issue);
  }
  for (const id of conflicted) byId.delete(id);
  return byId;
}

/** Saved roots establish read completeness independently of project membership. */
export function selectProjectAnchors(
  project: Pick<ProjectRecord, "workspaces">,
  workspace: string,
  issues: readonly BeadsIssue[],
): BeadsIssue[] {
  const scope = project.workspaces.find(
    (item) => workspaceKey(item.root) === workspaceKey(workspace),
  );
  if (!scope) return [];
  const anchors = new Set(scope.epicIds);
  return [...uniqueIssues(issues).values()].filter(
    (issue) => anchors.has(issue.id) && issue.type === "epic",
  );
}

/** Saved epic anchors permit creation, without making those epics project members. */
export function selectProjectCreationParents(
  project: Pick<ProjectRecord, "slug" | "workspaces">,
  workspace: string,
  issues: readonly BeadsIssue[],
): BeadsIssue[] {
  const scope = project.workspaces.find(
    (item) => workspaceKey(item.root) === workspaceKey(workspace),
  );
  if (!scope) return [];
  const allowed = new Set([
    ...scope.epicIds,
    ...selectProjectBeads(project, workspace, issues).map((issue) => issue.id),
  ]);
  return [...uniqueIssues(issues).values()].filter(
    (issue) =>
      allowed.has(issue.id) &&
      issue.type === "epic" &&
      issue.status !== "closed",
  );
}

/**
 * Decision 20: explicit epic ancestry AND `project:<slug>`, within the named
 * workspace. Repositories describe the project; a path grants no read access.
 * No id-prefix inference, arbitrary directory reads, or cross-workspace data.
 */
export function selectProjectBeads(
  project: Pick<ProjectRecord, "slug" | "workspaces">,
  workspace: string,
  issues: readonly BeadsIssue[],
): BeadsIssue[] {
  const scope = project.workspaces.find(
    (item) => workspaceKey(item.root) === workspaceKey(workspace),
  );
  if (!scope) return [];
  const byId = uniqueIssues(issues);
  const children = new Map<string, string[]>();
  for (const issue of byId.values()) {
    if (issue.parent) {
      const group = children.get(issue.parent) ?? [];
      group.push(issue.id);
      children.set(issue.parent, group);
    }
  }
  const included = new Set<string>();
  const pending = scope.epicIds.filter((id) => byId.get(id)?.type === "epic");
  for (let index = 0; index < pending.length; index++) {
    const id = pending[index];
    if (id === undefined || included.has(id)) continue;
    included.add(id);
    pending.push(...(children.get(id) ?? []));
  }
  return [...byId.values()].filter(
    (issue) =>
      included.has(issue.id) &&
      issue.labels?.includes(`project:${project.slug}`),
  );
}
