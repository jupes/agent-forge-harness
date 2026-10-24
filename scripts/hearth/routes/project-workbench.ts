import type { SmithsView } from "../../../types/hearth";
import type { ProjectWorkbenchHost } from "../../../types/project-workbench";
import { loadConfig } from "../../config/load";
import { ConversationError } from "../../conversations/error";
import { isProjectId, ProjectStoreError } from "../../projects/store";
import { projectWorkbench } from "../../projects/workbench";
import type { Eligibility } from "../../scheduler/eligibility";
import { createHostSampler, type HostLoad } from "../../scheduler/host-load";
import type { ReadRoute } from "../api";
import { coalesced, fail, type ReadDeps, withTimeout } from "./operator-reads";
import type { ProjectSnapshot } from "./project-summaries";

/** Current read-only observations; no new stream, admission, path authority or queue implementation. */
export function projectWorkbenchRoute(
  deps: ReadDeps,
  load: () => Promise<ProjectSnapshot>,
  readEligibility: () => Promise<Eligibility | null>,
  sampleHost: (threshold: number) => Promise<HostLoad> = createHostSampler(),
): ReadRoute<string> {
  const observe = coalesced(async () => {
    let smiths: SmithsView | null = null,
      host: ProjectWorkbenchHost | null = null;
    let threshold: number | null = null;
    try {
      const { config } = loadConfig({
        harnessRoot: deps.root,
        env: {},
        ...(deps.configHome !== undefined ? { home: deps.configHome } : {}),
      });
      smiths = {
        smiths: Object.values(config.smiths),
        benches: config.benches,
        defaultSmith: config.workflow.defaultCrew,
      };
      threshold = config.shift.throttle;
    } catch {
      /* Invalid configuration supplies no fallback smith or host threshold. */
    }
    const reads = await Promise.allSettled([
      withTimeout(
        readEligibility(),
        deps.bdTimeoutMs ?? 15000,
        "Eligibility read timed out.",
      ),
      threshold !== null
        ? withTimeout(sampleHost(threshold), 2500, "Host read timed out.")
        : Promise.resolve(null),
    ]);
    const eligible = reads[0]?.status === "fulfilled" ? reads[0].value : null;
    const sampled = reads[1]?.status === "fulfilled" ? reads[1].value : null;
    if (sampled && threshold !== null) host = { ...sampled, threshold };
    return { eligibility: eligible, smiths, host };
  });
  return {
    kind: "read",
    method: "GET",
    path: "/projects/:id/workbench",
    operatorOnly: true,
    validate(request) {
      const id = request.params["id"];
      if ([...request.query.keys()].length)
        return fail("The project Workbench takes no query parameters.");
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
        // Validate scope before asking for scheduler/reservation observations.
        projectWorkbench(project, snapshot.source, {
          eligibility: null,
          smiths: null,
          host: null,
        });
        return {
          status: 200,
          data: projectWorkbench(project, snapshot.source, await observe()),
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
