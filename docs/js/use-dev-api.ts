/**
 * Fetch a dev-only API route.
 *
 * These endpoints exist only while `bun run dashboard` is running. A failure
 * is therefore an expected state, not an exception: pages render a "needs the
 * local dashboard" message instead, the same way Plan review and Council do.
 */

import { useEffect, useState } from "preact/hooks";

const DEV_API = "/__agent-forge/dev-api";

export interface DevApiState<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
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
        const response = await fetch(`${DEV_API}${route}`);
        const envelope = (await response.json()) as {
          ok: boolean;
          data: T;
          error: string | null;
        };
        if (!live) return;
        if (!response.ok || !envelope.ok) {
          throw new Error(envelope.error ?? `HTTP ${response.status}`);
        }
        setState({ data: envelope.data, error: null, loading: false });
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
