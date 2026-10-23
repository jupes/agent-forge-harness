import { ConversationError } from "../../conversations/error";
import { projectBeads } from "../../projects/beads";
import { isProjectId, ProjectStoreError } from "../../projects/store";
import type { ReadRoute } from "../api";
import { fail, noParameters } from "./operator-reads";
import type { ProjectSnapshot } from "./project-summaries";

/** The common runner protects full live tracker details; saved paths grant no I/O. */
export function projectBeadsRoute(
  load: () => Promise<ProjectSnapshot>,
): ReadRoute<string> {
  return {
    kind: "read",
    method: "GET",
    path: "/projects/:id/beads",
    operatorOnly: true,
    validate: (request) => {
      const query = noParameters(request);
      if (!query.ok) return query;
      const id = request.params["id"];
      return isProjectId(id)
        ? { ok: true, value: id }
        : fail("Expected a project id.");
    },
    read: async (id) => {
      try {
        const snapshot = await load(),
          project = snapshot.catalog.projects.find((item) => item.id === id);
        if (!project)
          return {
            status: 404,
            error: "This project is not in the hearth catalog.",
          };
        return { status: 200, data: projectBeads(project, snapshot.source) };
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
