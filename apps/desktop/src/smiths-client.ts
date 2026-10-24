import { REAL_TIMERS, type Timers } from "../../../docs/js/hearth-read";
import {
  createRefetcher,
  type RefetcherOptions,
} from "../../../docs/js/use-stream";
import type { Scoreboard } from "../../../types/hearth";
import {
  inspectSmiths,
  type SmithInspection,
  sameSmithConfiguration,
} from "./smiths-model";
import {
  boundedSmithsValue,
  recordedScoreboardSchema,
  savedSmithConfigSchema,
  smithsViewSchema,
} from "./smiths-protocol";

export const SCOREBOARD_RANGES = [
  { id: "24h", label: "Last 24 hours", days: 1 },
  { id: "7d", label: "Last 7 days", days: 7 },
  { id: "30d", label: "Last 30 days", days: 30 },
  { id: "all", label: "All recorded", days: null },
] as const;
export type ScoreboardRange = (typeof SCOREBOARD_RANGES)[number]["id"];
interface ReadView<T> {
  data: T | null;
  loading: boolean;
  error: string;
  checkedAt: string | null;
}
export interface SmithsState {
  configuration: ReadView<SmithInspection>;
  scoreboard: ReadView<Scoreboard>;
  range: ScoreboardRange;
  scoreboardRange: ScoreboardRange | null;
  scoreboardSince: string | null;
}
export function createSmithsClient(deps: {
  configuration(
    signal: AbortSignal,
  ): Promise<{ config: unknown; smiths: unknown }>;
  scoreboard(since: string | null, signal: AbortSignal): Promise<unknown>;
  now?: () => number;
  timers?: Timers;
  refetch?: Omit<RefetcherOptions, "run">;
}) {
  const state: SmithsState = {
    configuration: { data: null, loading: false, error: "", checkedAt: null },
    scoreboard: { data: null, loading: false, error: "", checkedAt: null },
    range: "7d",
    scoreboardRange: null,
    scoreboardSince: null,
  };
  const now = deps.now ?? Date.now,
    timers = deps.timers ?? REAL_TIMERS;
  const listeners = new Set<() => void>();
  const pending = new Map<"configuration" | "scoreboard", () => void>();
  let closed = false,
    configEpoch = 0,
    scoreboardEpoch = 0;
  const emit = () => {
    if (!closed) for (const listener of listeners) listener();
  };
  const error = (cause: unknown) =>
    cause instanceof Error
      ? cause.message.slice(0, 2000)
      : "This read could not be verified. Retry to check again.";
  async function bounded<T>(
    key: "configuration" | "scoreboard",
    read: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    pending.get(key)?.();
    const control = new AbortController();
    let rejectCancelled: ((error: Error) => void) | undefined;
    const cancel = () => {
      control.abort();
      rejectCancelled?.(Error("Observer replaced."));
    };
    pending.set(key, cancel);
    const deadline = new Promise<never>((_, reject) => {
      rejectCancelled = reject;
    });
    const timer = timers.set(() => {
      control.abort();
      rejectCancelled?.(
        Error(
          "This read did not finish within 45 seconds. Earlier verified values are kept; retry to check again.",
        ),
      );
    }, 45_000);
    try {
      return await Promise.race([read(control.signal), deadline]);
    } finally {
      timers.clear(timer);
      if (pending.get(key) === cancel) pending.delete(key);
    }
  }
  async function refreshConfiguration() {
    if (closed) return;
    const epoch = ++configEpoch;
    state.configuration.loading = true;
    emit();
    try {
      const raw = await bounded("configuration", deps.configuration);
      if (closed || epoch !== configEpoch) return;
      const loaded = savedSmithConfigSchema.safeParse(
        boundedSmithsValue(raw.config),
      );
      const smiths = smithsViewSchema.safeParse(boundedSmithsValue(raw.smiths));
      if (!loaded.success || !smiths.success)
        throw Error(
          "Saved smith values or their sources could not be verified. Retry to check again.",
        );
      if (!sameSmithConfiguration(loaded.data, smiths.data))
        throw Error(
          "The configuration changed between reads. Retry to verify the saved values and provenance together.",
        );
      state.configuration = {
        data: inspectSmiths(loaded.data),
        loading: false,
        error: "",
        checkedAt: new Date(now()).toISOString(),
      };
    } catch (cause) {
      if (!closed && epoch === configEpoch)
        state.configuration = {
          ...state.configuration,
          loading: false,
          error: error(cause),
        };
    } finally {
      if (!closed && epoch === configEpoch) emit();
    }
  }
  async function refreshScoreboard() {
    if (closed) return;
    const epoch = ++scoreboardEpoch,
      range = state.range;
    const selected = SCOREBOARD_RANGES.find((entry) => entry.id === range);
    const since = selected?.days
      ? new Date(now() - selected.days * 86_400_000).toISOString()
      : null;
    state.scoreboard.loading = true;
    emit();
    try {
      const raw = await bounded("scoreboard", (signal) =>
        deps.scoreboard(since, signal),
      );
      if (closed || epoch !== scoreboardEpoch) return;
      const parsed = recordedScoreboardSchema.safeParse(
        boundedSmithsValue(raw),
      );
      if (!parsed.success)
        throw Error(
          "Recorded scoreboard values could not be verified. Retry to check again.",
        );
      const data = parsed.data;
      if (since && data.from && Date.parse(data.from) < Date.parse(since))
        throw Error("The scoreboard did not match the requested range.");
      state.scoreboard = {
        data,
        loading: false,
        error: "",
        checkedAt: new Date(now()).toISOString(),
      };
      state.scoreboardRange = range;
      state.scoreboardSince = since;
    } catch (cause) {
      if (!closed && epoch === scoreboardEpoch)
        state.scoreboard = {
          ...state.scoreboard,
          loading: false,
          error: error(cause),
        };
    } finally {
      if (!closed && epoch === scoreboardEpoch) emit();
    }
  }
  const configRefetcher = createRefetcher({
    ...deps.refetch,
    run: refreshConfiguration,
  });
  const boardRefetcher = createRefetcher({
    ...deps.refetch,
    run: refreshScoreboard,
  });
  return {
    get: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    refreshConfiguration,
    refreshScoreboard,
    setRange(range: ScoreboardRange) {
      if (!SCOREBOARD_RANGES.some((entry) => entry.id === range))
        return Promise.resolve();
      state.range = range;
      return refreshScoreboard();
    },
    changed() {
      if (!closed) {
        configRefetcher.request();
        boardRefetcher.request();
      }
    },
    dispose() {
      closed = true;
      configEpoch++;
      scoreboardEpoch++;
      configRefetcher.dispose();
      boardRefetcher.dispose();
      for (const cancel of pending.values()) cancel();
      pending.clear();
      listeners.clear();
    },
  };
}
export type SmithsClient = ReturnType<typeof createSmithsClient>;
