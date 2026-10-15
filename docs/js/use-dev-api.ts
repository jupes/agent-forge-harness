/**
 * Fetch a dev-only API route.
 *
 * These endpoints exist only while `bun run dashboard` is running. A failure
 * is therefore an expected state, not an exception: pages render a "needs the
 * local dashboard" message instead, the same way Plan review and Council do.
 * Each read is made under `readHearth`'s rules (`hearth-read.ts`): within its
 * time limit, and not at all on a static copy.
 */

import { useEffect, useState } from "preact/hooks";
import {
  type HearthReadOptions,
  readHearth,
  servedStatically,
} from "./hearth-read";

const DEV_API = "/__agent-forge/dev-api";

export interface DevApiState<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
}

/** One read of a dev-only route. Rejects when it did not answer with its data. */
export async function fetchDevApi<T>(
  route: string,
  options: HearthReadOptions = {},
): Promise<T> {
  return readHearth(
    `${DEV_API}${route}`,
    async (response) => {
      const envelope = (await response.json()) as {
        ok: boolean;
        data: T;
        error: string | null;
      };
      if (!response.ok || !envelope.ok)
        throw new Error(envelope.error ?? `HTTP ${response.status}`);
      return envelope.data;
    },
    options,
  );
}

export function useDevApi<T>(route: string): DevApiState<T> {
  const [state, setState] = useState<DevApiState<T>>({
    data: null,
    error: null,
    loading: true,
  });

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const data = await fetchDevApi<T>(route, {
          staticCopy: servedStatically(),
        });
        if (live) setState({ data, error: null, loading: false });
      } catch (cause) {
        if (!live) return;
        setState({
          data: null,
          error: cause instanceof Error ? cause.message : String(cause),
          loading: false,
        });
      }
    })();
    return () => {
      live = false;
    };
  }, [route]);

  return state;
}
