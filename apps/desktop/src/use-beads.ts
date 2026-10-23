import { useEffect, useRef, useState } from "preact/hooks";
import { operatorRead } from "../../../docs/js/operator";
import {
  appStream,
  pageReads,
  readOperatorRoute,
  startLiveRead,
} from "../../../docs/js/use-stream";
import { projectBeadsPageSchema } from "../../../scripts/projects/beads-protocol";
import type { ProjectBeadsPage } from "../../../types/project-beads";

/** Uses the window's existing ledger stream and bounded read coordinator. */
export function useBeads(
  projectId: string | null,
  selectedId: string | null = null,
) {
  const [state, setState] = useState<{
    data: ProjectBeadsPage | null;
    error: string | null;
    loading: boolean;
  }>({ data: null, error: null, loading: projectId !== null });
  const live = useRef<ReturnType<
    typeof startLiveRead<ProjectBeadsPage>
  > | null>(null);
  useEffect(() => {
    setState({ data: null, error: null, loading: projectId !== null });
    if (!projectId) return;
    const read = startLiveRead<ProjectBeadsPage>({
      load: async () => {
        const value = await readOperatorRoute<unknown>(
          `/projects/${encodeURIComponent(projectId)}/beads${selectedId ? `?beadId=${encodeURIComponent(selectedId)}` : ""}`,
          { ...pageReads(), fetch: operatorRead },
        );
        const parsed = projectBeadsPageSchema.safeParse(value);
        if (!parsed.success || parsed.data.projectId !== projectId)
          throw Error(
            "The live bead read could not be verified. Refresh to check again.",
          );
        return parsed.data;
      },
      reportRefreshError: true,
      client: appStream(),
      kinds: [
        "bead.transitioned",
        "operator.action",
        "session.started",
        "session.ended",
      ],
      onChange: setState,
    });
    live.current = read;
    return () => {
      read();
      if (live.current === read) live.current = null;
    };
  }, [projectId, selectedId]);
  return {
    ...state,
    data: state.data?.projectId === projectId ? state.data : null,
    reload: () => live.current?.reload(),
  };
}
