import { REAL_TIMERS, type Timers } from "../../../docs/js/hearth-read";
import {
  createRefetcher,
  type RefetcherOptions,
  type WatchReason,
} from "../../../docs/js/use-stream";
import {
  projectActivityDetailSchema,
  projectActivityFiltersSchema,
  projectActivityPageSchema,
} from "../../../scripts/projects/activity-protocol";
import type {
  ProjectActivityDetail,
  ProjectActivityEvent,
  ProjectActivityFilters,
} from "../../../types/project-activity";

export const ACTIVITY_LIMITS = {
  pages: 50,
  rows: 10_000,
  bytes: 8 * 1024 * 1024,
  timeoutMs: 45_000,
} as const;
export interface ProjectActivityView {
  events: ProjectActivityEvent[];
  workspace: string | null;
  loading: boolean;
  loaded: boolean;
  more: boolean;
  nextAfter: number;
  cut: boolean;
  paused: boolean;
  asOf: string | null;
  membershipComplete: boolean;
  problems: string[];
  error: string;
  notice: string;
  selectedId: number | null;
  detail: ProjectActivityDetail | null;
  detailLoading: boolean;
  detailError: string;
  detailStale: boolean;
}

/** Immutable scope, replaceable observer. Dependencies deliberately contain only protected reads. */
export function createProjectActivityClient(deps: {
  projectId: string;
  workspace: string | null;
  filters: ProjectActivityFilters;
  read(after: number): Promise<unknown>;
  detail(id: number): Promise<unknown>;
  refetch?: Omit<RefetcherOptions, "run">;
  timers?: Timers;
  /** Tests may lower bounds; callers cannot raise the production limits. */
  limits?: Partial<Record<keyof typeof ACTIVITY_LIMITS, number>>;
}) {
  const filters = projectActivityFiltersSchema.parse(deps.filters);
  const filterKey = JSON.stringify(filters);
  const bound = (key: keyof typeof ACTIVITY_LIMITS) => {
    const value = deps.limits?.[key];
    return typeof value === "number" && Number.isFinite(value)
      ? Math.max(1, Math.min(ACTIVITY_LIMITS[key], Math.floor(value)))
      : ACTIVITY_LIMITS[key];
  };
  const limits = {
    pages: bound("pages"),
    rows: bound("rows"),
    bytes: bound("bytes"),
    timeoutMs: bound("timeoutMs"),
  };
  const state: ProjectActivityView = {
    events: [],
    workspace: deps.workspace,
    loading: false,
    loaded: false,
    more: false,
    nextAfter: 0,
    cut: false,
    paused: false,
    asOf: null,
    membershipComplete: false,
    problems: [],
    error: "",
    notice: "",
    selectedId: null,
    detail: null,
    detailLoading: false,
    detailError: "",
    detailStale: false,
  };
  const listeners = new Set<() => void>();
  const timers = deps.timers ?? REAL_TIMERS;
  let disposed = false,
    readEpoch = 0,
    selectionEpoch = 0,
    membershipEpoch = 0,
    mode: "replace" | "append" | "more" = "replace",
    cancelRead: (() => void) | null = null;
  const emit = () => {
    if (!disposed) for (const listener of listeners) listener();
  };
  const message = (error: unknown) =>
    error instanceof Error
      ? error.message.slice(0, 2000)
      : "Activity could not be read. Refresh to try again.";
  const retain = (incoming: ProjectActivityEvent[], replace: boolean) => {
    const rows = [...(replace ? [] : state.events), ...incoming];
    const sizes = rows.map(
      (row) => new TextEncoder().encode(JSON.stringify(row)).length,
    );
    let bytes = sizes.reduce((sum, count) => sum + count, 0),
      drop = 0;
    while (
      drop < rows.length &&
      (rows.length - drop > limits.rows || bytes > limits.bytes)
    ) {
      bytes -= sizes[drop] ?? 0;
      drop++;
    }
    state.events = rows.slice(drop);
    state.cut = (replace ? false : state.cut) || drop > 0;
  };
  const readSelected = async () => {
    const id = state.selectedId;
    if (
      disposed ||
      id === null ||
      state.asOf === null ||
      state.workspace === null
    )
      return;
    const epoch = ++selectionEpoch;
    const checkedMembership = membershipEpoch;
    state.detailLoading = true;
    state.detailError = "";
    emit();
    try {
      const parsed = projectActivityDetailSchema.safeParse(
        await deps.detail(id),
      );
      if (disposed || epoch !== selectionEpoch || state.selectedId !== id)
        return;
      if (
        !parsed.success ||
        parsed.data.projectId !== deps.projectId ||
        parsed.data.workspace !== state.workspace ||
        parsed.data.event.id !== id
      )
        throw Error(
          "The selected event does not match this project and workspace.",
        );
      state.detail = parsed.data;
      state.detailStale = checkedMembership !== membershipEpoch;
    } catch (error) {
      if (!disposed && epoch === selectionEpoch) {
        state.detailError = message(error);
        state.detailStale = state.detail !== null;
      }
    } finally {
      if (!disposed && epoch === selectionEpoch) {
        state.detailLoading = false;
        emit();
      }
    }
  };
  const reader = createRefetcher({
    ...deps.refetch,
    async run() {
      if (disposed) return;
      const epoch = ++readEpoch,
        current = () => !disposed && readEpoch === epoch;
      const replacing = mode === "replace" || !state.loaded;
      mode = "append";
      let after = replacing ? 0 : state.nextAfter,
        first = true,
        pages = 0,
        timer: unknown = null;
      state.loading = true;
      state.paused = false;
      emit();
      const expire = new Promise<never>((_, reject) => {
        timer = timers.set(
          () =>
            reject(
              Error(
                "Activity did not finish its bounded read. Earlier verified events are kept; refresh or narrow the filters.",
              ),
            ),
          limits.timeoutMs,
        );
        cancelRead = () => {
          if (timer !== null) timers.clear(timer);
          reject(Error("Activity observer closed."));
        };
      });
      const drain = async () => {
        while (current()) {
          const parsed = projectActivityPageSchema.safeParse(
            await deps.read(after),
          );
          if (!current()) return;
          if (
            !parsed.success ||
            parsed.data.projectId !== deps.projectId ||
            (state.workspace !== null &&
              parsed.data.workspace !== state.workspace) ||
            parsed.data.after !== after ||
            JSON.stringify(parsed.data.filters) !== filterKey
          )
            throw Error(
              "Activity returned invalid metadata or a different project, workspace, filter or cursor. Earlier verified events are kept.",
            );
          const page = parsed.data;
          retain(page.events, replacing && first);
          state.workspace = page.workspace;
          state.asOf = page.asOf;
          state.nextAfter = page.nextAfter;
          state.more = page.more;
          state.loaded = true;
          state.membershipComplete = page.membershipComplete;
          state.problems = page.problems;
          state.error = "";
          state.notice = "";
          first = false;
          pages++;
          emit();
          if (!page.more) return;
          if (pages >= limits.pages) {
            state.paused = true;
            state.notice =
              "More history remains. Read more events to continue this bounded read.";
            return;
          }
          after = page.nextAfter;
        }
      };
      try {
        await Promise.race([drain(), expire]);
      } catch (error) {
        if (current()) state.error = message(error);
      } finally {
        if (timer !== null) timers.clear(timer);
        cancelRead = null;
        if (current()) {
          readEpoch++;
          state.loading = false;
          emit();
          if (
            state.selectedId !== null &&
            !state.detail &&
            !state.detailLoading
          )
            void readSelected();
        }
      }
    },
  });
  return {
    get: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    refresh() {
      if (disposed || state.loading) return;
      membershipEpoch++;
      if (state.detail) state.detailStale = true;
      mode = "replace";
      reader.request();
    },
    changed(reason: WatchReason = "events") {
      if (disposed) return;
      if (reason === "resync") {
        membershipEpoch++;
        if (state.detail) state.detailStale = true;
        emit();
        mode = "replace";
        reader.request();
        return;
      }
      if (state.more || !state.loaded) {
        state.notice =
          "Activity changed while history is still being read. Read the remaining events or refresh to check again.";
        emit();
        return;
      }
      reader.request();
    },
    loadMore() {
      if (disposed || state.loading || !state.more) return;
      mode = "more";
      reader.request();
    },
    select(id: number | null) {
      if (disposed) return;
      selectionEpoch++;
      state.selectedId = id;
      state.detail = null;
      state.detailError = "";
      state.detailLoading = false;
      state.detailStale = false;
      emit();
      if (id !== null) void readSelected();
    },
    refreshDetail() {
      if (!disposed && !state.detailLoading) void readSelected();
    },
    dispose() {
      disposed = true;
      readEpoch++;
      selectionEpoch++;
      cancelRead?.();
      cancelRead = null;
      reader.dispose();
      listeners.clear();
    },
  };
}
