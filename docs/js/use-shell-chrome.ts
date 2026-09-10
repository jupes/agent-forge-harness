/**
 * The snapshot state and refresh action every document's shell shows.
 *
 * `index.html`, `plan-review.html` and `council.html` each used to carry their
 * own copy of this (and `council.html` carried none at all, which is why it had
 * no refresh control). One hook now feeds all three.
 */

import { useCallback, useEffect, useState } from "preact/hooks";
import type { BeadsPayload } from "../../types/beads";
import { snapshotLabelFor } from "./app-state";

const BEADS_URL = "data/beads.json";
const REBUILD_PATH = "/__agent-forge/rebuild-pages";

export interface ShellChrome {
  payload: BeadsPayload | null;
  error: string | null;
  loading: boolean;
  refreshing: boolean;
  refresh: () => void;
  snapshotLabel: string;
  snapshotIso: string;
}

export function useShellChrome(): ShellChrome {
  const [payload, setPayload] = useState<BeadsPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const response = await fetch(BEADS_URL);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      setPayload((await response.json()) as BeadsPayload);
      setError(null);
    } catch (cause) {
      setPayload(null);
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const refresh = useCallback(() => {
    setRefreshing(true);
    void (async () => {
      try {
        const response = await fetch(REBUILD_PATH, { method: "POST" });
        const body = (await response.json().catch(() => ({}))) as {
          error?: string;
        };
        if (!response.ok) throw new Error(body.error ?? response.statusText);
        await load();
      } catch (cause) {
        window.alert(
          `Could not refresh the data snapshot.\n\n${
            cause instanceof Error ? cause.message : String(cause)
          }\n\nThis button talks to the Vite dev server only. If you opened files directly or use static hosting, run in the repo root:\n\n  bun run build-pages\n\nthen reload the page.`,
        );
      } finally {
        setRefreshing(false);
      }
    })();
  }, [load]);

  const { label, iso } = snapshotLabelFor(payload?.generatedAt ?? null);

  return {
    payload,
    error,
    loading,
    refreshing,
    refresh,
    snapshotLabel: label,
    snapshotIso: iso,
  };
}
