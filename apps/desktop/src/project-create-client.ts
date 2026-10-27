import type { ProjectCreateOptions } from "../../../scripts/projects/create-options-protocol";
import type {
  ProjectCreateDiscovery,
  ProjectCreateIdentity,
  ProjectCreateOriginal,
} from "../../../scripts/projects/create-protocol";
import { workspaceKey } from "../../../scripts/projects/scope";

type ProjectCreateDiscoveryRow = ProjectCreateDiscovery["operations"][number];

export interface ProjectCreateEntry {
  identity: ProjectCreateIdentity | ProjectCreateDiscoveryRow;
  original: ProjectCreateOriginal | null;
}

export interface ProjectCreateState {
  phase: "loading" | "ready" | "unavailable";
  options: ProjectCreateOptions | null;
  entries: ProjectCreateEntry[];
  error: string;
}

const emptyState = (): ProjectCreateState => ({
  phase: "loading",
  options: null,
  entries: [],
  error: "",
});

const sameSummary = (
  identity: ProjectCreateIdentity,
  row: ProjectCreateDiscoveryRow,
) =>
  identity.requestId === row.requestId &&
  identity.requestHash === row.requestHash &&
  identity.state === row.state &&
  identity.scopeCount === row.scopeCount &&
  identity.projectId === row.projectId;

/** App-root owner. Recovery is GET-only and bound to the verified workspace. */
export function createProjectCreateClient(deps: {
  workspace: string | null;
  options(): Promise<ProjectCreateOptions>;
  discovery(): Promise<ProjectCreateDiscovery>;
  original(requestId: string): Promise<ProjectCreateIdentity>;
  changed(): void;
}) {
  const state = emptyState();
  const listeners = new Set<() => void>();
  let disposed = false;
  let revision = 0;

  const emit = () => {
    if (disposed) return;
    deps.changed();
    for (const listener of listeners) listener();
  };
  const setUnavailable = (message: string, current: number) => {
    if (disposed || current !== revision) return;
    state.phase = "unavailable";
    state.error = message;
    state.options = null;
    state.entries = [];
    emit();
  };

  const recover = async () => {
    const current = ++revision;
    state.phase = "loading";
    state.error = "";
    emit();
    if (!deps.workspace) {
      setUnavailable("The trusted project workspace is unavailable.", current);
      return;
    }
    try {
      const [options, page] = await Promise.all([
        deps.options(),
        deps.discovery(),
      ]);
      if (disposed || current !== revision) return;
      const trustedWorkspace = workspaceKey(deps.workspace);
      if (
        !page.complete ||
        options.workspace.key !== trustedWorkspace ||
        workspaceKey(options.workspace.path) !== trustedWorkspace
      )
        throw Error("The project-create scope could not be verified.");

      const entries: ProjectCreateEntry[] = [];
      for (const row of page.operations) {
        if (row.state !== "reserved") {
          entries.push({ identity: row, original: null });
          continue;
        }
        const original = await deps.original(row.requestId);
        if (disposed || current !== revision) return;
        if (
          !sameSummary(original, row) ||
          original.state !== "reserved" ||
          workspaceKey(original.original.workspaces[0]!.root) !==
            trustedWorkspace
        )
          throw Error("A saved project original could not be correlated.");
        entries.push({ identity: original, original: original.original });
      }
      if (disposed || current !== revision) return;
      state.options = options;
      state.entries = entries;
      state.phase = "ready";
      state.error = "";
      emit();
    } catch {
      setUnavailable(
        "Saved project creation could not be verified. No new project was sent.",
        current,
      );
    }
  };

  return {
    get: () => structuredClone(state),
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    recover,
    dispose() {
      disposed = true;
      revision++;
      listeners.clear();
    },
  };
}
