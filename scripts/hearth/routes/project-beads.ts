import { ConversationError } from "../../conversations/error";
import { activeReservations, queryEventPage } from "../../ledger/query";
import { projectBeads } from "../../projects/beads";
import { isProjectId, ProjectStoreError } from "../../projects/store";
import type { ReadRoute } from "../api";
import { isBeadId } from "../tracker-write";
import { fail, hearthLedger, type ReadDeps } from "./operator-reads";
import type { ProjectSnapshot } from "./project-summaries";

/** The common runner protects full live tracker details; saved paths grant no I/O. */
export function projectBeadsRoute(
  deps: ReadDeps,
  load: () => Promise<ProjectSnapshot>,
): ReadRoute<{ projectId: string; beadId?: string }> {
  return {
    kind: "read",
    method: "GET",
    path: "/projects/:id/beads",
    operatorOnly: true,
    validate: (request) => {
      if (
        [...request.query.keys()].some(
          (key) => key !== "beadId" || request.query.getAll(key).length !== 1,
        )
      )
        return fail("Unsupported project bead query.");
      const beadId = request.query.get("beadId");
      if (beadId !== null && !isBeadId(beadId))
        return fail("Expected a bounded bead id.");
      const id = request.params["id"];
      return isProjectId(id)
        ? {
            ok: true,
            value: { projectId: id, ...(beadId !== null ? { beadId } : {}) },
          }
        : fail("Expected a project id.");
    },
    read: async ({ projectId: id, beadId }) => {
      try {
        const snapshot = await load(),
          project = snapshot.catalog.projects.find((item) => item.id === id);
        if (!project)
          return {
            status: 404,
            error: "This project is not in the hearth catalog.",
          };
        // First establish membership without touching history for an untrusted id.
        const data = projectBeads(project, snapshot.source, beadId);
        if (!beadId) return { status: 200, data };
        let events: ReturnType<typeof queryEventPage>["events"] | null = null,
          more = false,
          reservations: ReturnType<typeof activeReservations> | null = null;
        try {
          const page = queryEventPage(
            { workspace: deps.workspace, beadId, limit: 100 },
            hearthLedger(deps.ledgerPath),
          );
          events = page.events;
          more = page.more;
        } catch {
          /* Unavailable observations stay null. */
        }
        try {
          reservations = activeReservations(
            { workspace: deps.workspace },
            hearthLedger(deps.ledgerPath),
          );
        } catch {
          /* A failed reservation read is not an empty list. */
        }
        return {
          status: 200,
          data: projectBeads(project, snapshot.source, beadId, {
            events,
            more,
            reservations,
          }),
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
