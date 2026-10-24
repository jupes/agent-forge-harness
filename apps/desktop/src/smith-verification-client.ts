import { REAL_TIMERS, type Timers } from "../../../docs/js/hearth-read";
import {
  type SmithVerificationRead,
  smithVerificationReadSchema,
} from "../../../scripts/smith-verification";

export interface SmithVerificationState {
  open: boolean;
  loading: boolean;
  data: SmithVerificationRead | null;
  error: string;
}

/** Explicit, read-only observer. Closing fences even a reader that ignores cancellation. */
export function createSmithVerificationClient(deps: {
  workspace: string;
  read(signal: AbortSignal): Promise<unknown>;
  timers?: Timers;
}) {
  let state: SmithVerificationState = {
    open: false,
    loading: false,
    data: null,
    error: "",
  };
  let epoch = 0,
    disposed = false;
  let cancel: (() => void) | null = null;
  const listeners = new Set<() => void>();
  const timers = deps.timers ?? REAL_TIMERS;
  const emit = () => {
    if (!disposed) for (const listener of listeners) listener();
  };
  async function refresh() {
    if (disposed || !state.open || state.loading) return;
    const current = ++epoch;
    const control = new AbortController();
    let rejectRead: ((cause: Error) => void) | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      rejectRead = reject;
    });
    const cancelled = () => {
      control.abort();
      rejectRead?.(Error("Verification observer closed."));
    };
    cancel = cancelled;
    const timer = timers.set(() => {
      control.abort();
      rejectRead?.(
        Error(
          "The verification read did not finish within 45 seconds. Retry to check again.",
        ),
      );
    }, 45_000);
    state = { ...state, loading: true, error: "" };
    emit();
    try {
      const raw = await Promise.race([deps.read(control.signal), deadline]);
      if (disposed || current !== epoch || !state.open) return;
      const parsed = smithVerificationReadSchema.safeParse(raw);
      if (!parsed.success || parsed.data.workspace !== deps.workspace)
        throw Error(
          "The verification task and served workspace could not be verified. Retry to check again.",
        );
      state = { open: true, loading: false, error: "", data: parsed.data };
    } catch (cause) {
      if (!disposed && current === epoch && state.open)
        state = {
          ...state,
          loading: false,
          error:
            cause instanceof Error
              ? cause.message.slice(0, 2000)
              : "The verification task could not be read. Retry to check again.",
        };
    } finally {
      timers.clear(timer);
      if (cancel === cancelled) cancel = null;
      if (!disposed && current === epoch && state.open) emit();
    }
  }
  function close() {
    epoch++;
    state = { open: false, loading: false, data: null, error: "" };
    cancel?.();
    cancel = null;
    emit();
  }
  return {
    get: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    open() {
      if (disposed || state.open) return Promise.resolve();
      state = { ...state, open: true };
      return refresh();
    },
    refresh,
    close,
    dispose() {
      close();
      disposed = true;
      listeners.clear();
    },
  };
}
