import { activeReservations, queryEventPage } from "../../ledger/query";
import {
  buildProjectOverview,
  type ProjectHistory,
  projectHistoryStart,
} from "../../projects/overview";
import { isProjectId, ProjectStoreError } from "../../projects/store";
import { listShiftRecords } from "../../scheduler/shift-store";
import type { ReadRoute } from "../api";
import {
  fail,
  hearthLedger,
  noParameters,
  type ReadDeps,
} from "./operator-reads";
import type { ProjectSnapshot } from "./project-summaries";

export function projectOverviewRoute(
  deps: ReadDeps,
  load: () => Promise<ProjectSnapshot>,
): ReadRoute<string> {
  return {
    kind: "read",
    method: "GET",
    path: "/projects/:id/overview",
    validate: (request) => {
      const query = noParameters(request);
      if (!query.ok) return query;
      const id = request.params["id"];
      return isProjectId(id)
        ? { ok: true, value: id }
        : fail("Expected a project id.");
    },
    read: async (id) => {
      let snapshot: ProjectSnapshot;
      try {
        snapshot = await load();
      } catch (error) {
        if (error instanceof ProjectStoreError)
          return { status: error.status, error: error.message };
        throw error;
      }
      const project = snapshot.catalog.projects.find((item) => item.id === id);
      if (!project)
        return {
          status: 404,
          error: "This project is not in the hearth catalog.",
        };
      const history: ProjectHistory = {
        events: null,
        more: false,
        reservations: null,
        shifts: null,
      };
      try {
        const page = queryEventPage(
          {
            workspace: deps.workspace,
            since: projectHistoryStart(snapshot.source.asOf),
            limit: 10_000,
          },
          hearthLedger(deps.ledgerPath),
        );
        history.events = page.events;
        history.more = page.more;
      } catch {
        /* History failure does not erase the independent tracker read. */
      }
      try {
        history.reservations = activeReservations(
          { workspace: deps.workspace },
          hearthLedger(deps.ledgerPath),
        );
      } catch {
        /* The view renders its unavailable reservation state. */
      }
      if (deps.shiftsDir)
        history.shifts = listShiftRecords(deps.shiftsDir).filter(
          (row) => row.workspace === deps.workspace,
        );
      return {
        status: 200,
        data: buildProjectOverview(project, snapshot.source, history),
      };
    },
  };
}
