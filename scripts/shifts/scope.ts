import type { BeadsIssue } from "../../types/beads";
import type { ProjectShiftStartRequest } from "../../types/project-shifts";
import type { ProjectCatalog } from "../../types/projects";
import type { LoadedConfig } from "../config/load";
import { ConversationError } from "../conversations/error";
import { selectProjectBeads, workspaceKey } from "../projects/scope";
import { projectShiftOptions } from "../projects/shift-options";
import type { ProjectSources } from "../projects/summary";
import type { QueueDeps } from "../scheduler/queue";

function withinEpic(
  id: string,
  epic: string,
  issues: readonly BeadsIssue[],
): boolean {
  const byId = new Map(issues.map((issue) => [issue.id, issue]));
  const seen = new Set<string>();
  let next: string | undefined = id;
  while (next !== undefined && !seen.has(next)) {
    if (next === epic) return true;
    seen.add(next);
    next = byId.get(next)?.parent;
  }
  return false;
}

/** Current project authority only. Never called to authorize Stop, Recover or original reads. */
export function createProjectShiftScopeValidator(options: {
  workspace: string;
  load(): Promise<{ catalog: ProjectCatalog; source: ProjectSources }>;
  loadConfig(): LoadedConfig;
}) {
  const validate = async (
    projectId: string,
    request: ProjectShiftStartRequest,
  ) => {
    const { catalog, source } = await options.load();
    if (workspaceKey(source.workspace) !== workspaceKey(options.workspace))
      throw new ConversationError(
        409,
        "This hearth does not serve the observed project workspace.",
      );
    const project = catalog.projects.find((item) => item.id === projectId);
    if (!project)
      throw new ConversationError(
        404,
        "This project is not in the hearth catalog.",
      );
    if (project.archived)
      throw new ConversationError(
        409,
        "This project is archived. Existing owned shift controls remain available.",
      );
    if (request.expectedCatalogRevision !== catalog.revision)
      throw new ConversationError(
        409,
        "The project catalog changed. Review the current shift options before starting.",
      );
    const choices = projectShiftOptions(
      project,
      source,
      options.loadConfig(),
      catalog.revision,
    );
    if (
      request.options.epic !== undefined &&
      !choices.epics.some((epic) => epic.id === request.options.epic)
    )
      throw new ConversationError(
        409,
        "The reviewed epic is not an epic in the current project scope.",
      );
    if (
      request.options.smith !== undefined &&
      !choices.smiths.names.includes(request.options.smith)
    )
      throw new ConversationError(
        409,
        "The reviewed smith is no longer enabled.",
      );
    // projectShiftOptions refused absent/partial issues before returning choices.
    return { project, source };
  };
  return {
    async validateStart(
      projectId: string,
      request: ProjectShiftStartRequest,
    ): Promise<void> {
      await validate(projectId, request);
    },
    beforeStart(
      projectId: string,
      request: ProjectShiftStartRequest,
    ): NonNullable<QueueDeps["beforeStart"]> {
      return async (id, shown) => {
        try {
          const { project, source } = await validate(projectId, request);
          if (
            !Array.isArray(shown["labels"]) ||
            !shown["labels"].includes(`project:${project.slug}`) ||
            source.issues === null
          )
            return false;
          const members = selectProjectBeads(
            project,
            options.workspace,
            source.issues,
          );
          return (
            members.some((item) => item.id === id) &&
            (request.options.epic === undefined ||
              withinEpic(id, request.options.epic, source.issues))
          );
        } catch {
          return false;
        }
      };
    },
  };
}
