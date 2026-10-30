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
  projectRunArtifactSchema,
  projectRunDetailSchema,
  projectRunSessionHistorySchema,
  projectRunsPageSchema,
} from "../../../scripts/projects/run-protocol";
import type {
  ProjectRunArtifact,
  ProjectRunDetail,
  ProjectRunSessionHistory,
  ProjectRunsPage,
} from "../../../types/project-runs";

const MAX_RETAINED_RUN_SESSIONS = 1000;

export interface ProjectRunsView {
  page: ProjectRunsPage | null;
  loading: boolean;
  error: string;
  selectedSlug: string | null;
  detail: ProjectRunDetail | null;
  detailLoading: boolean;
  detailError: string;
  detailStale: boolean;
  sessionHistoryLoading: boolean;
  sessionHistoryError: string;
  sessionHistoryStale: boolean;
  sessionHistoryCapped: boolean;
  artifactKind?: "research" | "plan" | "ship" | null;
  artifact?: ProjectRunArtifact | null;
  artifactLoading?: boolean;
  artifactError?: string;
  artifactStale?: boolean;
}

/** Immutable project/source observer. Only protected reads are accepted; no run control dependency. */
export function createProjectRunsClient(deps: {
  projectId: string;
  workspace: string | null;
  list(signal: AbortSignal): Promise<unknown>;
  detail(
    slug: string,
    signal: AbortSignal,
    after?: number,
    limit?: number,
  ): Promise<unknown>;
  artifact?(
    slug: string,
    kind: "research" | "plan" | "ship",
    signal: AbortSignal,
  ): Promise<unknown>;
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
    sessionHistoryLoading: false,
    sessionHistoryError: "",
    sessionHistoryStale: false,
    sessionHistoryCapped: false,
    artifactKind: null,
    artifact: null,
    artifactLoading: false,
    artifactError: "",
    artifactStale: false,
  };
  const listeners = new Set<() => void>();
  const timers = deps.timers ?? REAL_TIMERS;
  const pending = new Map<
    "list" | "detail" | "sessions" | "artifact",
    () => void
  >();
  let closed = false,
    listEpoch = 0,
    detailEpoch = 0,
    sessionEpoch = 0;
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
    key: "list" | "detail" | "sessions" | "artifact",
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
  let artifactEpoch = 0;
  function invalidateArtifact() {
    artifactEpoch++;
    pending.get("artifact")?.();
    state.artifactLoading = false;
    state.artifactStale = state.artifact !== null;
  }
  function invalidateDetail() {
    detailEpoch++;
    sessionEpoch++;
    pending.get("detail")?.();
    pending.get("sessions")?.();
    state.detailLoading = false;
    state.detailStale = state.detail !== null;
    state.sessionHistoryLoading = false;
    state.sessionHistoryStale =
      state.detail?.sessionHistory?.status === "available";
    invalidateArtifact();
  }
  async function refreshDetail() {
    const slug = state.selectedSlug;
    if (closed || slug === null || !state.page || state.loading || state.error)
      return;
    if (!state.page.runs.some((run) => run.slug === slug)) {
      invalidateDetail();
      state.detail = null;
      state.detailStale = false;
      state.artifact = null;
      state.artifactKind = null;
      state.artifactError = "";
      state.artifactStale = false;
      state.sessionHistoryLoading = false;
      state.sessionHistoryError = "";
      state.sessionHistoryCapped = false;
      state.sessionHistoryStale = false;
      state.detailError =
        "This run is not in this project's current run list. It may be unavailable or outside this scope.";
      emit();
      return;
    }
    invalidateArtifact();
    sessionEpoch++;
    pending.get("sessions")?.();
    state.sessionHistoryLoading = false;
    const epoch = ++detailEpoch,
      membership = listEpoch;
    state.detailLoading = true;
    state.sessionHistoryLoading = true;
    state.detailError = "";
    state.sessionHistoryError = "";
    emit();
    try {
      const response = await bounded("detail", (signal) =>
        deps.detail(slug, signal, 0, 100),
      );
      const hasHistory =
        typeof response === "object" &&
        response !== null &&
        !Array.isArray(response) &&
        Object.prototype.hasOwnProperty.call(response, "sessionHistory");
      const core =
        typeof response === "object" &&
        response !== null &&
        !Array.isArray(response)
          ? Object.fromEntries(
              Object.entries(response).filter(
                ([key]) => key !== "sessionHistory",
              ),
            )
          : response;
      const parsed = projectRunDetailSchema.safeParse(core);
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
      const rawHistory =
        typeof response === "object" &&
        response !== null &&
        !Array.isArray(response) &&
        "sessionHistory" in response
          ? response.sessionHistory
          : undefined;
      const checkedHistory = hasHistory
        ? projectRunSessionHistorySchema.safeParse(rawHistory)
        : null;
      let sessionHistory: ProjectRunSessionHistory;
      if (!checkedHistory) {
        sessionHistory = {
          status: "unavailable",
          after: 0,
          reason: "unsupported-server",
        };
      } else if (
        !checkedHistory.success ||
        checkedHistory.data.after !== 0
      ) {
        sessionHistory = {
          status: "unavailable",
          after: 0,
          reason: "ledger-unavailable",
        };
      } else {
        sessionHistory = checkedHistory.data;
      }
      state.detail = { ...parsed.data, sessionHistory };
      state.detailStale = false;
      state.sessionHistoryStale = false;
      state.sessionHistoryCapped = false;
    } catch (cause) {
      if (!closed && epoch === detailEpoch) {
        state.detailError = error(cause);
        state.detailStale = state.detail !== null;
        state.sessionHistoryStale =
          state.detail?.sessionHistory?.status === "available";
      }
    } finally {
      if (!closed && epoch === detailEpoch) {
        state.detailLoading = false;
        state.sessionHistoryLoading = false;
        emit();
      }
    }
  }
  async function loadMoreSessions() {
    const slug = state.selectedSlug;
    const detail = state.detail;
    const history = detail?.sessionHistory;
    if (
      closed ||
      !slug ||
      !detail ||
      !history ||
      history.status !== "available" ||
      !history.more ||
      state.loading ||
      state.error ||
      state.detailLoading ||
      state.detailStale ||
      state.sessionHistoryLoading ||
      state.sessionHistoryStale ||
      state.sessionHistoryCapped ||
      !state.page?.runs.some((run) => run.slug === slug)
    )
      return;
    const after = history.nextAfter;
    if (!Number.isSafeInteger(after) || after < 0) return;
    const epoch = ++sessionEpoch,
      detailGeneration = detailEpoch,
      membership = listEpoch;
    state.sessionHistoryLoading = true;
    state.sessionHistoryError = "";
    emit();
    try {
      const parsed = projectRunDetailSchema.safeParse(
        await bounded("sessions", (signal) =>
          deps.detail(slug, signal, after, 100),
        ),
      );
      if (
        closed ||
        epoch !== sessionEpoch ||
        detailGeneration !== detailEpoch ||
        membership !== listEpoch ||
        state.selectedSlug !== slug ||
        state.detail !== detail
      )
        return;
      if (
        !parsed.success ||
        parsed.data.projectId !== deps.projectId ||
        parsed.data.workspace !== workspace ||
        parsed.data.checkout !== checkout ||
        parsed.data.run.slug !== slug
      )
        throw Error("This session page does not match the verified project and run.");
      const page = parsed.data.sessionHistory;
      if (!page)
        throw Error("This server does not provide recorded run sessions.");
      if (page.status === "unavailable")
        throw Error("Recorded session history is unavailable. Refresh to retry.");
      if (page.after !== after)
        throw Error("This session page does not match its requested cursor.");
      if (page.membershipKey !== history.membershipKey)
        throw Error(
          "Project or session membership changed while reading this run. Refresh Runs before continuing.",
        );
      const seen = new Set(history.sessions.map((session) => session.sessionId));
      const sessions = [...history.sessions];
      for (const session of page.sessions) {
        if (seen.has(session.sessionId)) continue;
        seen.add(session.sessionId);
        sessions.push(session);
      }
      if (sessions.length > MAX_RETAINED_RUN_SESSIONS) {
        state.sessionHistoryCapped = true;
        state.sessionHistoryError =
          "The retained session list reached its limit; this page was not added. Refresh to restart the bounded history read.";
        state.sessionHistoryStale = false;
        return;
      }
      state.detail = {
        ...parsed.data,
        sessionHistory: {
          status: "available",
          after: history.after,
          nextAfter: page.nextAfter,
          more: page.more,
          membershipKey: history.membershipKey,
          sessions,
        },
      };
      state.sessionHistoryStale = false;
      state.sessionHistoryCapped = false;
    } catch (cause) {
      if (!closed && epoch === sessionEpoch) {
        state.sessionHistoryError = error(cause);
        state.sessionHistoryStale = true;
      }
    } finally {
      if (!closed && epoch === sessionEpoch) {
        state.sessionHistoryLoading = false;
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
  async function openArtifact(kind: "research" | "plan" | "ship") {
    const slug = state.selectedSlug;
    const detail = state.detail;
    const phase = detail?.run.phases.find((row) => row.id === kind);
    const expected =
      kind === "research"
        ? `plans/research/${slug}.md`
        : kind === "plan"
          ? `plans/drafts/${slug}.md`
          : `reports/${slug}-ship.md`;
    if (
      closed ||
      !slug ||
      !detail ||
      state.detailLoading ||
      state.detailStale ||
      !phase ||
      phase.state !== "complete" ||
      phase.artifact !== expected
    )
      return;
    invalidateArtifact();
    const epoch = ++artifactEpoch,
      membership = listEpoch,
      selectedDetail = detail;
    if (state.artifactKind !== kind) {
      state.artifact = null;
      state.artifactStale = false;
    }
    state.artifactKind = kind;
    state.artifactLoading = true;
    state.artifactError = "";
    emit();
    try {
      const parsed = projectRunArtifactSchema.safeParse(
        await bounded("artifact", (signal) => {
          if (!deps.artifact) throw Error("Artifact reads are unavailable.");
          return deps.artifact(slug, kind, signal);
        }),
      );
      if (
        closed ||
        epoch !== artifactEpoch ||
        membership !== listEpoch ||
        state.selectedSlug !== slug ||
        state.detail !== selectedDetail
      )
        return;
      if (
        !parsed.success ||
        parsed.data.projectId !== deps.projectId ||
        parsed.data.workspace !== workspace ||
        parsed.data.checkout !== checkout ||
        parsed.data.slug !== slug ||
        parsed.data.kind !== kind ||
        parsed.data.artifact !== expected
      )
        throw Error(
          "This artifact does not match the verified project, run and phase.",
        );
      const digest = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(parsed.data.content),
      );
      const hash = [...new Uint8Array(digest)]
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
      if (
        closed ||
        epoch !== artifactEpoch ||
        membership !== listEpoch ||
        state.selectedSlug !== slug ||
        state.detail !== selectedDetail
      )
        return;
      if (hash !== parsed.data.sha256)
        throw Error("This artifact's integrity check did not match.");
      state.artifact = parsed.data;
      state.artifactStale = false;
    } catch (cause) {
      if (!closed && epoch === artifactEpoch) {
        state.artifactError = error(cause);
        state.artifactStale = state.artifact !== null;
      }
    } finally {
      if (!closed && epoch === artifactEpoch) {
        state.artifactLoading = false;
        emit();
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
    loadMoreSessions,
    openArtifact,
    select(slug: string | null) {
      if (closed || slug === state.selectedSlug) return;
      invalidateDetail();
      state.selectedSlug = slug;
      state.detail = null;
      state.artifact = null;
      state.artifactKind = null;
      state.detailError = "";
      state.detailStale = false;
      state.sessionHistoryLoading = false;
      state.sessionHistoryError = "";
      state.sessionHistoryStale = false;
      state.sessionHistoryCapped = false;
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
      sessionEpoch++;
      refetcher.dispose();
      for (const cancel of pending.values()) cancel();
      pending.clear();
      listeners.clear();
    },
  };
}
export type ProjectRunsClient = ReturnType<typeof createProjectRunsClient>;
