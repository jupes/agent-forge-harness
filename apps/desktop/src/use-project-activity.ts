import { useEffect, useRef, useState } from "preact/hooks";
import { readHearth } from "../../../docs/js/hearth-read";
import { operatorRead } from "../../../docs/js/operator";
import { appStream, pageReads } from "../../../docs/js/use-stream";
import { LEDGER_EVENT_KINDS } from "../../../types/hearth";
import type { ProjectActivityFilters } from "../../../types/project-activity";
import {
  createProjectActivityClient,
  type ProjectActivityView,
} from "./project-activity-client";
import { activityPagePath } from "./project-activity-model";
import { readProjectActivityResponse } from "./project-activity-response";

export interface ProjectActivityController {
  client: ReturnType<typeof createProjectActivityClient> | null;
  view: ProjectActivityView | null;
}

/** Scope replacement closes only observers. It shares the window's existing ledger stream. */
export function useProjectActivity(
  projectId: string | null,
  workspace: string | null,
  filters: ProjectActivityFilters | null,
  selectedId: number | null,
): ProjectActivityController {
  const key = JSON.stringify([projectId, workspace, filters]);
  const selected = useRef(selectedId);
  selected.current = selectedId;
  const held = useRef<{
    key: string;
    client: ReturnType<typeof createProjectActivityClient>;
  } | null>(null);
  const [snapshot, paint] = useState<{
    key: string;
    view: ProjectActivityView;
  } | null>(null);
  useEffect(() => {
    if (!projectId || !filters) return;
    const client = createProjectActivityClient({
      projectId,
      workspace,
      filters,
      read: (after) =>
        readHearth(
          activityPagePath(projectId, filters, after),
          readProjectActivityResponse,
          { ...pageReads(), fetch: operatorRead },
        ),
      detail: (id) =>
        readHearth(
          `/__agent-forge/projects/${encodeURIComponent(projectId)}/activity/${id}`,
          readProjectActivityResponse,
          { ...pageReads(), fetch: operatorRead },
        ),
    });
    held.current = { key, client };
    const changed = () => paint({ key, view: { ...client.get() } });
    const unsubscribe = client.subscribe(changed);
    let missed = false;
    const follow = (reason: "events" | "resync") => {
      if (document.visibilityState !== "visible") {
        missed = true;
        return;
      }
      client.changed(reason);
    };
    const stream = appStream();
    const unwatch = stream.watch(
      LEDGER_EVENT_KINDS.filter((kind) => kind !== "operator.action"),
      follow,
    );
    const membership = stream.watch(["operator.action"], () =>
      follow("resync"),
    );
    const visible = () => {
      if (missed && document.visibilityState === "visible") {
        missed = false;
        client.changed("resync");
      }
    };
    document.addEventListener("visibilitychange", visible);
    client.select(selected.current);
    client.refresh();
    changed();
    return () => {
      if (held.current?.client === client) held.current = null;
      unsubscribe();
      unwatch();
      membership();
      document.removeEventListener("visibilitychange", visible);
      client.dispose();
    };
  }, [key]);
  useEffect(() => {
    if (held.current?.key === key) held.current.client.select(selectedId);
  }, [key, selectedId]);
  return {
    client: held.current?.key === key ? held.current.client : null,
    view: snapshot?.key === key ? snapshot.view : null,
  };
}
