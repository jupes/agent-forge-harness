import { useEffect, useRef, useState } from "preact/hooks";
import { operatorRead } from "../../../docs/js/operator";
import {
  appStream,
  pageReads,
  readOperatorRoute,
  startLiveRead,
} from "../../../docs/js/use-stream";
import { projectWorkbenchPageSchema } from "../../../scripts/projects/workbench-protocol";
import type { ProjectWorkbenchPage } from "../../../types/project-workbench";

/** Reuses the window stream; periodic bounded reads keep host observations current. */
export function useWorkbench(projectId: string | null) {
  const [state, setState] = useState<{
    data: ProjectWorkbenchPage | null;
    error: string | null;
    loading: boolean;
  }>({ data: null, error: null, loading: projectId !== null });
  const live = useRef<ReturnType<
    typeof startLiveRead<ProjectWorkbenchPage>
  > | null>(null);
  useEffect(() => {
    setState({ data: null, error: null, loading: projectId !== null });
    if (!projectId) return;
    const read = startLiveRead<ProjectWorkbenchPage>({
      load: async () => {
        setState((previous) => ({ ...previous, loading: true }));
        const value = await readOperatorRoute<unknown>(
          `/projects/${encodeURIComponent(projectId)}/workbench`,
          { ...pageReads(), fetch: operatorRead },
        );
        const parsed = projectWorkbenchPageSchema.safeParse(value);
        if (!parsed.success || parsed.data.projectId !== projectId)
          throw Error(
            "The Workbench read could not be verified. Refresh to check again.",
          );
        return parsed.data;
      },
      reportRefreshError: true,
      client: appStream(),
      kinds: [
        "bead.transitioned",
        "operator.action",
        "reservation.acquired",
        "reservation.released",
        "session.started",
        "session.ended",
        "shift.started",
        "shift.stopped",
        "gate.ran",
      ],
      onChange: setState,
    });
    live.current = read;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") read.reload();
    }, 15000);
    return () => {
      window.clearInterval(timer);
      read();
      if (live.current === read) live.current = null;
    };
  }, [projectId]);
  return {
    ...state,
    data: state.data?.projectId === projectId ? state.data : null,
    reload: () => live.current?.reload(),
  };
}
