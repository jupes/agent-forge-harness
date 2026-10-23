import { loadConfig } from "../../config/load";
import { ConversationError } from "../../conversations/error";
import { projectShiftOptions } from "../../projects/shift-options";
import { isProjectId, ProjectStoreError } from "../../projects/store";
import type { ReadRoute } from "../api";
import { fail, type ReadDeps } from "./operator-reads";
import type { ProjectSnapshot } from "./project-summaries";

/** Project-scoped defaults are read-only and cannot reserve or dispatch a shift. */
export function projectShiftOptionsRoute(
  deps: ReadDeps,
  load: () => Promise<ProjectSnapshot>,
): ReadRoute<string> {
  return {
    kind: "read",
    method: "GET",
    path: "/projects/:id/shifts/options",
    operatorOnly: true,
    validate(request) {
      if ([...request.query.keys()].length)
        return fail("Shift options take no query parameters.");
      const id = request.params["id"];
      return isProjectId(id)
        ? { ok: true, value: id }
        : fail("Expected a project id.");
    },
    async read(id) {
      try {
        const snapshot = await load();
        const project = snapshot.catalog.projects.find(
          (item) => item.id === id,
        );
        if (!project)
          return {
            status: 404,
            error: "This project is not in the hearth catalog.",
          };
        let loaded: ReturnType<typeof loadConfig>;
        try {
          loaded = loadConfig({
            harnessRoot: deps.root,
            env: {},
            ...(deps.configHome !== undefined ? { home: deps.configHome } : {}),
          });
        } catch {
          throw new ConversationError(
            503,
            "Current shift defaults could not be verified. Refresh before starting a shift.",
          );
        }
        return {
          status: 200,
          data: projectShiftOptions(
            project,
            snapshot.source,
            loaded,
            snapshot.catalog.revision,
          ),
        };
      } catch (error) {
        if (
          error instanceof ConversationError ||
          error instanceof ProjectStoreError
        )
          return { status: error.status, error: error.message };
        throw error;
      }
    },
  };
}
