import {
  READ_TIMEOUT_MS,
  REAL_TIMERS,
  type Timers,
} from "../../../docs/js/hearth-read";
import {
  createRefetcher,
  type RefetcherOptions,
} from "../../../docs/js/use-stream";
import {
  projectRunDetailSchema,
  projectRunsPageSchema,
} from "../../../scripts/projects/run-protocol";
import type {
  ProjectRunDetail,
  ProjectRunsPage,
} from "../../../types/project-runs";

export interface ProjectRunsView {
  page: ProjectRunsPage | null;
  loading: boolean;
  error: string;
  selectedSlug: string | null;
  detail: ProjectRunDetail | null;
  detailLoading: boolean;
  detailError: string;
  detailStale: boolean;
}

/** Immutable project/source observer. Only protected reads are accepted; no run control dependency. */
export function createProjectRunsClient(deps: {
  projectId: string;
  workspace: string | null;
  list(signal: AbortSignal): Promise<unknown>;
  detail(slug: string, signal: AbortSignal): Promise<unknown>;
  timers?: Timers;
  refetch?: Omit<RefetcherOptions, "run">;
}) {
  const state: ProjectRunsView = {
    page: null,
    loading: false,
    error: "",
    selectedSlug: null,
    detail: null,
    detailLoading: false,
    detailError: "",
    detailStale: false,
  };
  const listeners = new Set<() => void>();
  const timers = deps.timers ?? REAL_TIMERS;
  const pending = new Map<"list" | "detail", () => void>();
  let closed = false,
    listEpoch = 0,
    detailEpoch = 0;
  let workspace = deps.workspace,
    checkout: string | null = null;
  const emit = () => {
    if (!closed) for (const listener of listeners) listener();
  };
  const error = (cause: unknown) =>
    cause instanceof Error
      ? cause.message.slice(0, 2000)
      : "Run metadata could not be verified. Retry to check again.";
  async function bounded<T>(
    key: "list" | "detail",
    read: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    pending.get(key)?.();
    const control = new AbortController();
    let rejectCancelled: ((cause: Error) => void) | undefined;
    const cancel = () => {
      control.abort();
      rejectCancelled?.(Error("Observer replaced."));
    };
    pending.set(key, cancel);
    const cancelled = new Promise<never>((_, reject) => {
      rejectCancelled = reject;
    });
    const timer = timers.set(() => {
      control.abort();
      rejectCancelled?.(
        Error(
          "This read did not finish within 45 seconds. Earlier verified metadata is kept; retry to check again.",
        ),
      );
    }, READ_TIMEOUT_MS);
    try {
      return await Promise.race([read(control.signal), cancelled]);
    } finally {
      timers.clear(timer);
      if (pending.get(key) === cancel) pending.delete(key);
    }
  }
  function invalidateDetail() {
    detailEpoch++;
    pending.get("detail")?.();
    state.detailLoading = false;
    state.detailStale = state.detail !== null;
  }
  async function refreshDetail() {
    const slug = state.selectedSlug;
    if (closed || slug === null || !state.page || state.loading || state.error)
      return;
    if (!state.page.runs.some((run) => run.slug === slug)) {
      invalidateDetail();
      state.detail = null;
      state.detailStale = false;
      state.detailError =
        "This run is not in this project's current run list. It may be unavailable or outside this scope.";
      emit();
      return;
    }
    const epoch = ++detailEpoch,
      membership = listEpoch;
    state.detailLoading = true;
    state.detailError = "";
    emit();
    try {
      const parsed = projectRunDetailSchema.safeParse(
        await bounded("detail", (signal) => deps.detail(slug, signal)),
      );
      if (
        closed ||
        epoch !== detailEpoch ||
        membership !== listEpoch ||
        state.selectedSlug !== slug
      )
        return;
      if (
        !parsed.success ||
        parsed.data.projectId !== deps.projectId ||
        parsed.data.workspace !== workspace ||
        parsed.data.checkout !== checkout ||
        parsed.data.run.slug !== slug
      )
        throw Error(
          "This run detail does not match the verified project and served checkout.",
        );
      state.detail = parsed.data;
      state.detailStale = false;
    } catch (cause) {
      if (!closed && epoch === detailEpoch) {
        state.detailError = error(cause);
        state.detailStale = state.detail !== null;
      }
    } finally {
      if (!closed && epoch === detailEpoch) {
        state.detailLoading = false;
        emit();
      }
    }
  }
  async function refresh() {
    if (closed) return;
    const epoch = ++listEpoch;
    invalidateDetail();
    state.loading = true;
    emit();
    try {
      const parsed = projectRunsPageSchema.safeParse(
        await bounded("list", deps.list),
      );
      if (closed || epoch !== listEpoch) return;
      if (
        !parsed.success ||
        parsed.data.projectId !== deps.projectId ||
        (workspace !== null && parsed.data.workspace !== workspace) ||
        (checkout !== null && parsed.data.checkout !== checkout)
      )
        throw Error(
          "Run metadata does not match this project and served checkout.",
        );
      workspace = parsed.data.workspace;
      checkout = parsed.data.checkout;
      state.page = parsed.data;
      state.error = "";
    } catch (cause) {
      if (!closed && epoch === listEpoch) state.error = error(cause);
    } finally {
      if (!closed && epoch === listEpoch) {
        state.loading = false;
        emit();
        if (!state.error) void refreshDetail();
      }
    }
  }
  const refetcher = createRefetcher({ ...deps.refetch, run: refresh });
  return {
    get: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    refresh,
    refreshDetail,
    select(slug: string | null) {
      if (closed || slug === state.selectedSlug) return;
      invalidateDetail();
      state.selectedSlug = slug;
      state.detail = null;
      state.detailError = "";
      state.detailStale = false;
      emit();
      void refreshDetail();
    },
    changed() {
      if (!closed) refetcher.request();
    },
    dispose() {
      closed = true;
      listEpoch++;
      detailEpoch++;
      refetcher.dispose();
      for (const cancel of pending.values()) cancel();
      pending.clear();
      listeners.clear();
    },
  };
}
export type ProjectRunsClient = ReturnType<typeof createProjectRunsClient>;
