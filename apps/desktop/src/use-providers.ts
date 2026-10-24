import { useEffect, useRef, useState } from "preact/hooks";
import { actionOutcome } from "../../../docs/js/action-outcome";
import { operatorPost, operatorRead } from "../../../docs/js/operator";
import {
  appStream,
  pageReads,
  readOperatorRoute,
  startLiveRead,
} from "../../../docs/js/use-stream";
import { providerReadinessPageSchema } from "../../../scripts/providers/protocol";
import type {
  ProviderReadinessPage,
  ReadinessProvider,
} from "../../../types/provider-readiness";
import { providerReportStale } from "./providers-model";
import { useProviderLogins } from "./use-provider-logins";

/** Mounted once at the app root; navigation and all meters share this exact read. */
export function useProviders() {
  const [now, setNow] = useState(Date.now);
  const [checking, setChecking] = useState(false);
  const lock = useRef(false);
  const [state, setState] = useState<{
    data: ProviderReadinessPage | null;
    error: string | null;
    loading: boolean;
  }>({ data: null, error: null, loading: true });
  const logins = useProviderLogins(state.data?.workspace);
  const live = useRef<ReturnType<
    typeof startLiveRead<ProviderReadinessPage>
  > | null>(null);
  useEffect(() => {
    const read = startLiveRead<ProviderReadinessPage>({
      load: async () => {
        setState((previous) => ({ ...previous, loading: true }));
        const value = await readOperatorRoute<unknown>("/providers/readiness", {
          ...pageReads(),
          fetch: operatorRead,
        });
        const parsed = providerReadinessPageSchema.safeParse(value);
        if (!parsed.success)
          throw Error(
            "The provider report could not be verified. Refresh to check again.",
          );
        return parsed.data;
      },
      client: appStream(),
      kinds: ["session.ended", "operator.action"],
      reportRefreshError: true,
      onChange: (update) =>
        setState((previous) => {
          const next = update(previous);
          return next.data &&
            previous.data &&
            next.data.asOf < previous.data.asOf
            ? { ...next, data: previous.data }
            : next;
        }),
    });
    live.current = read;
    const timer = window.setInterval(() => {
      setNow(Date.now());
      if (document.visibilityState === "visible") read.reload();
    }, 15000);
    const visible = () => {
      setNow(Date.now());
      if (document.visibilityState === "visible") read.reload();
    };
    document.addEventListener("visibilitychange", visible);
    return () => {
      document.removeEventListener("visibilitychange", visible);
      window.clearInterval(timer);
      read();
      if (live.current === read) live.current = null;
    };
  }, []);
  return {
    ...state,
    logins,
    stale:
      state.data !== null &&
      (Boolean(state.error) || providerReportStale(state.data, now)),
    checking,
    reload: () => live.current?.reload(),
    async doctor(provider: ReadinessProvider) {
      if (lock.current) return;
      lock.current = true;
      setChecking(true);
      try {
        const outcome = await actionOutcome(
          () => operatorPost(`/__agent-forge/providers/${provider}/doctor`, {}),
          "The status check may have finished. Refresh to read its current result.",
        );
        if (outcome.state !== "done") throw Error(outcome.message);
        const parsed = providerReadinessPageSchema.safeParse(outcome.data);
        if (!parsed.success)
          throw Error(
            "The doctor result could not be verified. Refresh to check the current report.",
          );
        setState((previous) => ({
          ...previous,
          data: parsed.data,
          error: null,
          loading: false,
        }));
        live.current?.reload();
      } catch {
        setState((previous) => ({
          ...previous,
          error:
            "The doctor result could not be verified. Refresh to read current status before relying on it.",
        }));
      } finally {
        lock.current = false;
        setChecking(false);
      }
    },
  };
}
