import {
  createRefetcher,
  type Refetcher,
  type RefetcherOptions,
} from "../../../docs/js/use-stream";
import {
  projectSessionObservationsSchema,
  sessionObservationDetailSchema,
} from "../../../scripts/projects/session-observations-protocol";
import type { OwnedCodingSessionRecord } from "../../../types/codex-owned-task";
import type {
  ProjectSessionObservations,
  SessionObservationDetail,
  SessionObservedActivity,
  SessionOwnershipMetadata,
} from "../../../types/session-observations";
import { sessionObservationRows } from "./session-observations";

export interface ObservationProjectView {
  projectId: string;
  workspace: string | null;
  data: ProjectSessionObservations | null;
  owners: SessionOwnershipMetadata[];
  loading: boolean;
  loaded: boolean;
  error: string;
}
export interface ObservationDetailView {
  projectId: string;
  sessionId: string;
  workspace: string | null;
  data: SessionObservationDetail | null;
  activity: SessionObservedActivity[];
  loading: boolean;
  loaded: boolean;
  error: string;
  more: boolean;
  capped: boolean;
  nextAfter: number;
}
interface Dependencies {
  index(projectId: string): Promise<unknown>;
  detail(projectId: string, sessionId: string, after: number): Promise<unknown>;
  refetch?: Omit<RefetcherOptions, "run">;
}
const message = (cause: unknown) =>
  cause instanceof Error
    ? cause.message.slice(0, 2000)
    : "Session metadata could not be read. Refresh to try again.";
export const MAX_OBSERVED_ACTIVITY_ITEMS = 1000;

/** App-root readonly metadata cache. There is deliberately no POST/Stop/resume dependency. */
export function createSessionObservationsClient(deps: Dependencies) {
  const projects = new Map<string, ObservationProjectView>(),
    details = new Map<string, ObservationDetailView>(),
    listeners = new Set<() => void>();
  let active: {
    projectId: string;
    workspace: string | null;
    sessionId: string | null;
  } | null = null;
  let projectGeneration = 0,
    selectionGeneration = 0,
    disposed = false,
    indexRefresh: Refetcher | null = null,
    detailRefresh: Refetcher | null = null;
  const emit = () => {
    for (const listener of listeners) listener();
  };
  const project = (projectId: string): ObservationProjectView => {
    let view = projects.get(projectId);
    if (!view) {
      view = {
        projectId,
        workspace: null,
        data: null,
        owners: [],
        loading: false,
        loaded: false,
        error: "",
      };
      projects.set(projectId, view);
    }
    return view;
  };
  const detail = (
    projectId: string,
    sessionId: string,
  ): ObservationDetailView => {
    const key = `${projectId}:${sessionId}`;
    let view = details.get(key);
    if (!view) {
      view = {
        projectId,
        sessionId,
        workspace: null,
        data: null,
        activity: [],
        loading: false,
        loaded: false,
        error: "",
        more: false,
        capped: false,
        nextAfter: 0,
      };
      details.set(key, view);
    }
    return view;
  };
  const projectCurrent = (id: string, generation: number) =>
    !disposed && active?.projectId === id && projectGeneration === generation;
  const detailCurrent = (id: string, session: string, generation: number) =>
    !disposed &&
    active?.projectId === id &&
    active.sessionId === session &&
    selectionGeneration === generation;
  const clearDetail = (view: ObservationDetailView, workspace: string) => {
    view.workspace = workspace;
    view.data = null;
    view.activity = [];
    view.loaded = false;
    view.loading = false;
    view.error = "";
    view.more = false;
    view.capped = false;
    view.nextAfter = 0;
  };
  async function readIndex(
    id: string,
    workspace: string | null,
    generation: number,
  ) {
    if (!projectCurrent(id, generation)) return;
    const view = project(id);
    view.loading = true;
    emit();
    try {
      const raw = await deps.index(id);
      if (!projectCurrent(id, generation)) return;
      const parsed = projectSessionObservationsSchema.safeParse(raw);
      if (
        !parsed.success ||
        parsed.data.projectId !== id ||
        (workspace !== null && parsed.data.workspace !== workspace)
      )
        throw Error(
          "The returned session index does not match this project and workspace.",
        );
      const data = parsed.data;
      if (view.workspace !== null && view.workspace !== data.workspace) {
        view.owners = [];
        for (const selected of details.values())
          if (selected.projectId === id) clearDetail(selected, data.workspace);
      }
      const retained = new Map(
        view.owners
          .filter(
            (owner) =>
              owner.record.projectId === id &&
              owner.record.workspace === data.workspace,
          )
          .map((owner) => [owner.record.id, owner]),
      );
      for (const owner of data.ownership.records)
        retained.set(owner.record.id, owner);
      if (retained.size > 1000)
        throw Error(
          "The retained ownership index exceeds this view's limit. Previously verified ownership is kept.",
        );
      view.workspace = data.workspace;
      view.data = data;
      view.loaded = true;
      view.error = "";
      view.owners = [...retained.values()];
    } catch (cause) {
      if (projectCurrent(id, generation)) {
        view.loaded = true;
        view.error = message(cause);
      }
    } finally {
      if (projectCurrent(id, generation)) {
        view.loading = false;
        emit();
      }
    }
  }
  async function readDetail(
    id: string,
    session: string,
    workspace: string | null,
    generation: number,
  ) {
    if (!detailCurrent(id, session, generation)) return;
    const view = detail(id, session);
    if (view.capped) return;
    const after = view.nextAfter;
    view.loading = true;
    emit();
    try {
      const raw = await deps.detail(id, session, after);
      if (!detailCurrent(id, session, generation)) return;
      const parsed = sessionObservationDetailSchema.safeParse(raw);
      if (
        !parsed.success ||
        parsed.data.projectId !== id ||
        parsed.data.sessionId !== session ||
        parsed.data.after !== after ||
        view.nextAfter !== after ||
        (workspace !== null && parsed.data.workspace !== workspace)
      )
        throw Error(
          "The returned activity page does not match this selected session and workspace.",
        );
      const page = parsed.data;
      if (view.workspace !== null && view.workspace !== page.workspace)
        throw Error(
          "This session's workspace changed. Reopen it from the verified session index.",
        );
      const merged = [...view.activity, ...page.activity];
      if (
        merged.length > MAX_OBSERVED_ACTIVITY_ITEMS ||
        new TextEncoder().encode(JSON.stringify(merged)).byteLength >
          4 * 1024 * 1024
      ) {
        view.capped = true;
        view.more = true;
        view.error =
          "This view has reached its saved activity limit. Earlier metadata is kept; more activity is not loaded here.";
      } else {
        view.activity = merged;
        view.nextAfter = page.nextAfter;
        view.more = page.more;
        view.error = "";
      }
      view.workspace = page.workspace;
      view.data = page;
      view.loaded = true;
    } catch (cause) {
      if (detailCurrent(id, session, generation)) {
        view.loaded = true;
        view.error = message(cause);
      }
    } finally {
      if (detailCurrent(id, session, generation)) {
        view.loading = false;
        emit();
      }
    }
  }
  return {
    project,
    detail,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    activate(
      projectId: string | null,
      sessionId: string | null,
      workspace: string | null,
    ) {
      if (disposed) return;
      const changed =
        active?.projectId !== projectId || active?.workspace !== workspace;
      const selectedChanged = changed || active?.sessionId !== sessionId;
      if (!changed && !selectedChanged) return;
      if (changed) {
        indexRefresh?.dispose();
        indexRefresh = null;
        projectGeneration++;
        if (active) project(active.projectId).loading = false;
      }
      if (selectedChanged) {
        detailRefresh?.dispose();
        detailRefresh = null;
        selectionGeneration++;
        if (active?.sessionId)
          detail(active.projectId, active.sessionId).loading = false;
      }
      active = projectId ? { projectId, workspace, sessionId } : null;
      if (!active) {
        emit();
        return;
      }
      if (changed) {
        const view = project(projectId!);
        if (
          workspace !== null &&
          view.workspace !== null &&
          workspace !== view.workspace
        ) {
          view.data = null;
          view.owners = [];
          view.loaded = false;
          view.error = "";
          view.workspace = workspace;
          for (const selected of details.values())
            if (selected.projectId === projectId)
              clearDetail(selected, workspace);
        }
        const generation = projectGeneration;
        indexRefresh = createRefetcher({
          ...deps.refetch,
          run: () => readIndex(projectId!, workspace, generation),
        });
        indexRefresh.request();
      }
      if (selectedChanged && sessionId) {
        const view = detail(projectId!, sessionId);
        if (
          workspace !== null &&
          view.workspace !== null &&
          workspace !== view.workspace
        )
          clearDetail(view, workspace);
        const generation = selectionGeneration;
        detailRefresh = createRefetcher({
          ...deps.refetch,
          run: () => readDetail(projectId!, sessionId, workspace, generation),
        });
        detailRefresh.request();
      }
      emit();
    },
    rows(
      projectId: string,
      genericRecords: readonly OwnedCodingSessionRecord[] = [],
    ) {
      const view = project(projectId),
        workspace =
          view.workspace ??
          (active?.projectId === projectId ? active.workspace : null) ??
          genericRecords[0]?.workspace;
      if (!workspace) return [];
      const reason =
        view.error || "The session ownership index is not yet available.";
      const source: ProjectSessionObservations = view.data
        ? {
            ...view.data,
            ...(view.error
              ? {
                  ownership: { available: false as const, records: [], reason },
                }
              : {}),
          }
        : {
            projectId,
            workspace,
            asOf: new Date(0).toISOString(),
            observations: [],
            observationsComplete: false,
            ownership: { available: false, records: [], reason },
            problems: [],
          };
      return sessionObservationRows(source, [
        ...genericRecords.map((record) => ({ record, origin: null })),
        ...view.owners,
      ]);
    },
    refreshIndex() {
      indexRefresh?.request();
    },
    refreshDetail() {
      detailRefresh?.request();
    },
    changed() {
      indexRefresh?.request();
      if (active?.sessionId) {
        const selected = detail(active.projectId, active.sessionId);
        if (!selected.loaded || !selected.more) detailRefresh?.request();
      }
    },
    dispose() {
      disposed = true;
      projectGeneration++;
      selectionGeneration++;
      indexRefresh?.dispose();
      detailRefresh?.dispose();
      listeners.clear();
    },
  };
}
export type SessionObservationsClient = ReturnType<
  typeof createSessionObservationsClient
>;
