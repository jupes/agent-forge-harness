import { version } from "../../../package.json";
import {
  type AppUpdateResult,
  appUpdateResultSchema,
} from "../../../scripts/desktop/app-update-protocol";
export interface AppUpdatesState {
  busy: boolean;
  last: Exclude<AppUpdateResult, { state: "unavailable" }> | null;
  fresh: boolean;
  error: string | null;
  attemptAt: string | null;
}
const problem =
  "The update check could not be verified. No installation was requested.";
const reasons = {
  "not-found":
    "No stable release information was returned. Update availability is unknown.",
  "rate-limited":
    "The release service refused this check. Update availability is unknown.",
  "unsupported-version":
    "This renderer version cannot be compared with the stable release feed.",
  closed: "The Hearth is closing. Reconnect before checking updates.",
  network: problem,
  timeout: problem,
  "invalid-response": problem,
};
/** Explicit metadata queries only. A lost response never repeats itself or requests installation. */
export function createAppUpdatesClient(deps: {
  post(): Promise<Response>;
  canCheck(): boolean;
  changed(): void;
}) {
  const state: AppUpdatesState = {
    busy: false,
    last: null,
    fresh: false,
    error: null,
    attemptAt: null,
  };
  let disposed = false;
  const publish = () => {
    if (!disposed) deps.changed();
  };
  return {
    state,
    async check() {
      if (disposed || state.busy || !deps.canCheck()) return;
      state.busy = true;
      state.fresh = false;
      state.error = null;
      publish();
      try {
        const response = await deps.post();
        const raw: unknown = await response.json();
        if (disposed) return;
        if (
          !response.ok ||
          !raw ||
          typeof raw !== "object" ||
          !("ok" in raw) ||
          raw.ok !== true ||
          !("error" in raw) ||
          raw.error !== null ||
          !("data" in raw)
        )
          throw Error(problem);
        const result = appUpdateResultSchema.parse(raw.data);
        if (result.currentVersion !== version) throw Error(problem);
        state.attemptAt = result.checkedAt;
        if (result.state === "unavailable")
          state.error = reasons[result.reason];
        else {
          state.last = result;
          state.fresh = true;
        }
      } catch {
        if (!disposed) {
          state.error = problem;
          state.attemptAt = null;
        }
      } finally {
        if (!disposed) {
          state.busy = false;
          publish();
        }
      }
    },
    dispose() {
      disposed = true;
    },
  };
}
