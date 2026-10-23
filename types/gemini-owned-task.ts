import type { GeminiTaskLaunch } from "./gemini-task";
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
