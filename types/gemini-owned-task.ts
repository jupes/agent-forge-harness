import type { ConversationReceipt } from "./conversation";
import type { GeminiTaskLaunch, SerializedGeminiTask } from "./gemini-task";
import type {
  GeminiTaskRuntimeEvent,
  PreparedGeminiTask,
} from "./gemini-task-runtime";
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

export interface GeminiTaskPreviewReceipt {
  provider: "gemini";
  projectId: string;
  requestId: string;
  snapshot: PreparedGeminiTask;
  serialized: SerializedGeminiTask;
}

export interface GeminiTaskPrivateFrame {
  kind: "coding-gemini-task";
  provider: "gemini";
  version: "0.65.0";
  event: GeminiTaskRuntimeEvent;
}
export interface GeminiTaskStartReceipt {
  session: GeminiOwnedSessionRecord;
  receipt: ConversationReceipt;
}
