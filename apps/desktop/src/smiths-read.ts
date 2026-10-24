import {
  type HearthReadOptions,
  readHearth,
} from "../../../docs/js/hearth-read";
import { type OperatorRead, operatorRead } from "../../../docs/js/operator";
import { pageReads } from "../../../docs/js/use-stream";
import { MAX_SMITH_VERIFICATION_BYTES } from "../../../scripts/smith-verification";
import { MAX_SMITHS_READ_BYTES } from "./smiths-protocol";
import { readSmithsResponse } from "./smiths-response";

/** The same narrow protected/receiving-bounded read boundary used by the desktop hook. */
export function createSmithsReads(
  deps: { reader?: OperatorRead; options?: HearthReadOptions } = {},
) {
  const reader = deps.reader ?? operatorRead;
  const read = (
    path: string,
    signal: AbortSignal,
    maxBytes = MAX_SMITHS_READ_BYTES,
  ) =>
    readHearth(
      `/__agent-forge${path}`,
      (response) => readSmithsResponse(response, maxBytes),
      {
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
            { maxBodyBytes: maxBytes + 1024 },
          ),
      },
    );
  return {
    verification: (signal: AbortSignal) =>
      read("/smiths/verification", signal, MAX_SMITH_VERIFICATION_BYTES),
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
