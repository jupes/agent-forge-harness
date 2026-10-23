import {
  type HearthReadOptions,
  readHearth,
} from "../../../docs/js/hearth-read";
import { type OperatorRead, operatorRead } from "../../../docs/js/operator";
import { pageReads } from "../../../docs/js/use-stream";
import { MAX_SMITHS_READ_BYTES } from "./smiths-protocol";
import { readSmithsResponse } from "./smiths-response";

/** The same narrow protected/receiving-bounded read boundary used by the desktop hook. */
export function createSmithsReads(
  deps: { reader?: OperatorRead; options?: HearthReadOptions } = {},
) {
  const reader = deps.reader ?? operatorRead;
  const read = (path: string, signal: AbortSignal) =>
    readHearth(`/__agent-forge${path}`, readSmithsResponse, {
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
          { maxBodyBytes: MAX_SMITHS_READ_BYTES + 1024 },
        ),
    });
  return {
    async configuration(signal: AbortSignal) {
      const [smiths, config] = await Promise.all([
        read("/smiths", signal),
        read("/config", signal),
      ]);
      return { smiths, config };
    },
    scoreboard: (since: string | null, signal: AbortSignal) =>
      read(
        `/scoreboard${since ? `?since=${encodeURIComponent(since)}` : ""}`,
        signal,
      ),
  };
}
