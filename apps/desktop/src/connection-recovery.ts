import { actionOutcome } from "../../../docs/js/action-outcome";
import type { LaunchOutcome, OperatorPost } from "../../../docs/js/operator";
import type { StreamClient } from "../../../docs/js/use-stream";
import { API_PREFIX } from "../../../scripts/hearth/paths";
import {
  compatibilityFromHealth,
  desktopConnection,
  type HearthCompatibility,
} from "./connection-state";

export const DESKTOP_RESTART = `${API_PREFIX}/desktop/restart`;
const CHECK =
  "The hearth may already have restarted. Check its connection and any pending workspace actions before trying again.";
const UNKNOWN: HearthCompatibility = {
  state: "unknown",
  reason: "Checking the hearth's compatibility version.",
};

export interface DesktopConnectionDeps {
  stream: StreamClient;
  health(): Promise<unknown>;
  post: OperatorPost;
  refreshSession(url: string): Promise<LaunchOutcome>;
}

/** Owns recovery only. Received collections and unknown writes stay in their existing page stores. */
export function createDesktopConnection(deps: DesktopConnectionDeps) {
  let compatibility = UNKNOWN;
  let busy = false;
  let unknown = false;
  let message: string | null = null;
  let live = false;
  let epoch = 0;
  const listeners = new Set<() => void>();
  let leave: (() => void) | null = null;
  const get = () => ({
    connection: desktopConnection(
      deps.stream.getState().status,
      deps.stream.getDiagnostics(),
      compatibility,
    ),
    busy,
    unknown,
    message,
  });
  const notify = () => {
    for (const listener of [...listeners]) listener();
  };
  const observe = () => {
    if (deps.stream.getState().status !== "live") {
      live = false;
      compatibility = UNKNOWN;
      epoch++;
    } else if (!live) {
      live = true;
      const mine = ++epoch;
      void deps
        .health()
        .then((data) => {
          if (mine !== epoch) return;
          compatibility = compatibilityFromHealth(data);
          notify();
        })
        .catch(() => {
          if (mine !== epoch) return;
          compatibility = {
            state: "unknown",
            reason:
              "The hearth's compatibility could not be checked. Restart the hearth to recover.",
          };
          notify();
        });
    }
    notify();
  };
  return {
    get,
    subscribe(listener: () => void) {
      listeners.add(listener);
      if (leave === null) {
        leave = deps.stream.subscribe(observe);
        observe();
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          epoch++;
          live = false;
          compatibility = UNKNOWN;
          leave?.();
          leave = null;
        }
      };
    },
    postProblem(url: string): string | null {
      if (url === DESKTOP_RESTART) return null;
      return !busy && get().connection.writesAllowed
        ? null
        : "Workspace actions are unavailable until the hearth connection and compatibility are verified.";
    },
    async restart(): Promise<void> {
      if (busy || unknown) return;
      busy = true;
      message = null;
      deps.stream.suspend();
      notify();
      try {
        const result = await actionOutcome(
          () => deps.post(DESKTOP_RESTART, {}),
          CHECK,
        );
        if (result.state !== "done") {
          unknown = result.state === "unknown";
          message = result.message;
          return;
        }
        const url =
          result.data !== null &&
          typeof result.data === "object" &&
          "url" in result.data
            ? result.data.url
            : null;
        if (typeof url !== "string")
          throw new Error("The hearth did not return a fresh launch link.");
        const session = await deps.refreshSession(url);
        if (session.state !== "exchanged")
          throw new Error(
            "The hearth restarted, but the desktop session could not be refreshed. Reopen the desktop to sign in again.",
          );
        message =
          "The hearth restarted. Pending actions have not been repeated.";
      } catch (error) {
        unknown = true;
        message = `${error instanceof Error ? error.message : "Recovery did not complete."} ${CHECK}`;
      } finally {
        busy = false;
        deps.stream.resumeFresh();
        notify();
      }
    },
    acknowledge() {
      unknown = false;
      message = null;
      notify();
    },
  };
}

export type DesktopRecovery = ReturnType<
  ReturnType<typeof createDesktopConnection>["get"]
>;
