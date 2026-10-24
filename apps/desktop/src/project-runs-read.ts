import {
  type HearthReadOptions,
  readHearth,
} from "../../../docs/js/hearth-read";
import { type OperatorRead, operatorRead } from "../../../docs/js/operator";
import { pageReads } from "../../../docs/js/use-stream";
import { MAX_PROJECT_RUN_BYTES } from "../../../scripts/projects/run-protocol";
import { readProjectRunsResponse } from "./project-runs-response";

/** Fixed project routes only. The server derives checkout and membership. */
export function createProjectRunsReads(
  projectId: string,
  deps: { reader?: OperatorRead; options?: HearthReadOptions } = {},
) {
  const reader = deps.reader ?? operatorRead;
  const path = `/__agent-forge/projects/${encodeURIComponent(projectId)}/runs`;
  const read = (url: string, signal: AbortSignal) =>
    readHearth(url, readProjectRunsResponse, {
      ...(deps.options ?? pageReads()),
      fetch: (url, init) =>
        reader(
          url,
          {
            ...init,
            signal: init?.signal
              ? AbortSignal.any([signal, init.signal])
              : signal,
          },
          { maxBodyBytes: MAX_PROJECT_RUN_BYTES + 1024 },
        ),
    });
  return {
    list: (signal: AbortSignal) => read(path, signal),
    detail: (slug: string, signal: AbortSignal) =>
      read(`${path}/${encodeURIComponent(slug)}`, signal),
  };
}
