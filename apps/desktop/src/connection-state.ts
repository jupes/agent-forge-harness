import type { LiveStatus } from "../../../docs/js/app-state";
import type { StreamDiagnostics } from "../../../docs/js/use-stream";
import { HEARTH_API_VERSION } from "../../../scripts/hearth/protocol";

/** Compatibility must come from an explicit producer, never a network error. */
export type HearthCompatibility =
  | { state: "compatible"; appVersion: string; hearthVersion: string }
  | { state: "mismatch"; appVersion: string; hearthVersion: string }
  | { state: "unknown"; reason: string };

export function compatibilityFromHealth(data: unknown): HearthCompatibility {
  const version =
    data !== null && typeof data === "object" && "apiVersion" in data
      ? data.apiVersion
      : undefined;
  if (
    typeof version !== "number" ||
    !Number.isSafeInteger(version) ||
    version <= 0
  )
    return {
      state: "unknown",
      reason:
        "The hearth does not report a supported compatibility version. Restart the hearth to use the bundled version.",
    };
  return {
    state: version === HEARTH_API_VERSION ? "compatible" : "mismatch",
    appVersion: String(HEARTH_API_VERSION),
    hearthVersion: String(version),
  };
}

export interface DesktopConnection {
  phase:
    | "connecting"
    | "connected"
    | "reconnecting"
    | "stopped"
    | "version-mismatch";
  label: string;
  detail: string;
  lastDataAt: number | null;
  lastKnown: boolean;
  retry: { attempt: number; total: number } | null;
  writesAllowed: boolean;
  action: "none" | "restart";
}

/** Read-only presentation contract for the desktop frame, home and projects. */
export function desktopConnection(
  status: LiveStatus,
  diagnostics: StreamDiagnostics,
  compatibility: HearthCompatibility,
): DesktopConnection {
  const lastKnown = diagnostics.lastDataAt !== null;
  const dataHint = lastKnown
    ? "Showing the last stream data."
    : "No stream data has been received.";
  if (status === "reconnecting" || status === "off") {
    const retry =
      status === "reconnecting" &&
      diagnostics.consecutiveFailures > 0 &&
      diagnostics.retryLimit > 0
        ? {
            attempt: Math.min(
              diagnostics.consecutiveFailures,
              diagnostics.retryLimit,
            ),
            total: diagnostics.retryLimit,
          }
        : null;
    return {
      phase: status === "off" ? "stopped" : "reconnecting",
      label: status === "off" ? "Stopped" : "Reconnecting",
      detail: `${status === "off" ? "The hearth connection stopped." : `Reconnecting to the hearth${retry ? ` · attempt ${retry.attempt} of ${retry.total}` : ""}.`} ${dataHint} Workspace actions are unavailable until the hearth answers.`,
      lastDataAt: diagnostics.lastDataAt,
      lastKnown,
      retry,
      writesAllowed: false,
      action: "restart",
    };
  }
  if (status === "live") {
    if (compatibility.state === "mismatch") {
      return {
        phase: "version-mismatch",
        label: "Version mismatch",
        detail: `The app ${compatibility.appVersion} and hearth ${compatibility.hearthVersion} have different compatibility versions. Workspace actions are unavailable until they match.`,
        lastDataAt: diagnostics.lastDataAt,
        lastKnown,
        retry: null,
        writesAllowed: false,
        action: "restart",
      };
    }
    const writesAllowed = compatibility.state === "compatible";
    return {
      phase: "connected",
      label: "Connected",
      detail: writesAllowed
        ? "Connected to the hearth. Workspace actions are available."
        : `Connected to the hearth. ${compatibility.state === "unknown" ? compatibility.reason : ""} Workspace actions are unavailable.`,
      lastDataAt: diagnostics.lastDataAt,
      lastKnown: false,
      retry: null,
      writesAllowed,
      action: writesAllowed ? "none" : "restart",
    };
  }
  return {
    phase: "connecting",
    label: "Connecting",
    detail: "Connecting to the hearth. Waiting for its first snapshot.",
    lastDataAt: diagnostics.lastDataAt,
    lastKnown: false,
    retry: null,
    writesAllowed: false,
    action: "none",
  };
}
