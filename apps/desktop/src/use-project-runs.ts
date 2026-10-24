import { useEffect, useRef, useState } from "preact/hooks";
import { appStream } from "../../../docs/js/use-stream";
import {
  createProjectRunsClient,
  type ProjectRunsClient,
  type ProjectRunsView,
} from "./project-runs-client";
import { createProjectRunsReads } from "./project-runs-read";

/** One watcher on the shared window stream; route generations fence every painted detail. */
export function useProjectRuns(
  projectId: string | null,
  workspace: string | null,
  slug: string | null,
) {
  const key = JSON.stringify([projectId, workspace]);
  const held = useRef<{ key: string; client: ProjectRunsClient } | null>(null);
  const [snapshot, paint] = useState<{
    key: string;
    view: ProjectRunsView;
  } | null>(null);
  useEffect(() => {
    if (!projectId) return;
    const client = createProjectRunsClient({
      projectId,
      workspace,
      ...createProjectRunsReads(projectId),
    });
    held.current = { key, client };
    const changed = () => paint({ key, view: { ...client.get() } });
    const unsubscribe = client.subscribe(changed);
    let missed = false;
    const refresh = () => {
      if (document.visibilityState !== "visible") {
        missed = true;
        return;
      }
      client.changed();
    };
    const unwatch = appStream().watch(
      [
        "run.phase.entered",
        "run.phase.completed",
        "gate.ran",
        "review.recorded",
        "verdict.bound",
        "operator.action",
      ],
      refresh,
    );
    const visible = () => {
      if (missed && document.visibilityState === "visible") {
        missed = false;
        client.changed();
      }
    };
    document.addEventListener("visibilitychange", visible);
    client.select(slug);
    void client.refresh();
    changed();
    return () => {
      if (held.current?.client === client) held.current = null;
      unsubscribe();
      unwatch();
      document.removeEventListener("visibilitychange", visible);
      client.dispose();
    };
  }, [key]);
  useEffect(() => {
    if (held.current?.key === key) held.current.client.select(slug);
  }, [key, slug]);
  const client = held.current?.key === key ? held.current.client : null;
  const view = snapshot?.key === key ? snapshot.view : null;
  // Selection effects run after paint. Never project the previous run in that intervening frame.
  return {
    client,
    view:
      view && view.selectedSlug !== slug
        ? {
            ...view,
            selectedSlug: slug,
            detail: null,
            detailError: "",
            detailLoading: slug !== null,
            detailStale: false,
          }
        : view,
  };
}
export type ProjectRunsController = ReturnType<typeof useProjectRuns>;
