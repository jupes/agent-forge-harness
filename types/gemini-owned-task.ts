import type { GeminiTaskLaunch } from "./gemini-task";
import type { OwnedSessionMetadata, OwnedSessionRecord } from "./owned-session";
import type { SessionStartRequest } from "./session-requests";

/** Public native selections only. Scope, prepared evidence and executable authority belong to the hearth. */
export interface GeminiTaskStartRequest
  extends Omit<SessionStartRequest, "launch"> {
  provider: "gemini";
  launch: Omit<
    GeminiTaskLaunch,
    "cwd" | "context" | "policyFiles" | "includeDirectories"
  >;
}

export interface GeminiOwnedSessionMetadata
  extends Omit<
    OwnedSessionMetadata,
    "provider" | "mode" | "requestedModel" | "requestedEffort"
  > {
  provider: "gemini";
  route: "gemini-cli";
  mode: "task";
  requestedModel: string | null;
  requestedEffort: null;
}
export interface GeminiOwnedSessionRecord
  extends GeminiOwnedSessionMetadata,
    Omit<OwnedSessionRecord, keyof OwnedSessionMetadata> {}
