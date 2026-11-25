import {
  ProjectWorkMapLimitError,
  projectWorkMap,
} from "../../projects/project-work-map";
import {
  MAX_PROJECT_WORK_MAP_BYTES,
  projectWorkMapSchema,
} from "../../projects/project-work-map-protocol";
import { ProjectStoreError } from "../../projects/store";
import type { ReadRoute } from "../api";
import { noParameters } from "./operator-reads";
import type { ProjectSnapshot } from "./project-summaries";

export function projectWorkMapRoute(
  load: () => Promise<ProjectSnapshot>,
  workingSince: (sessionId: string) => number | undefined,
): ReadRoute<null> {
  return {
    kind: "read",
    method: "GET",
    path: "/projects/work-map",
    operatorOnly: true,
    validate: noParameters,
    read: async () => {
      try {
        const { catalog, source } = await load();
        const data = projectWorkMap(catalog, source, workingSince);
        if (
          Buffer.byteLength(JSON.stringify(data)) > MAX_PROJECT_WORK_MAP_BYTES
        )
          throw new ProjectWorkMapLimitError();
        if (!projectWorkMapSchema.safeParse(data).success)
          return {
            status: 503,
            error: "The local Work Map data could not be verified.",
          };
        return { status: 200, data };
      } catch (error) {
        if (error instanceof ProjectWorkMapLimitError)
          return { status: 503, error: error.message };
        if (error instanceof ProjectStoreError)
          return { status: error.status, error: error.message };
        throw error;
      }
    },
  };
}
