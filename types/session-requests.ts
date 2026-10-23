import type { ConversationObject, ConversationReceipt } from "./conversation";
import type { OwnedSessionRecord } from "./owned-session";
import type {
  ClaudeSessionLaunch,
  SerializedClaudeLaunch,
} from "./session-launch";
import type { SessionTurnSnapshot } from "./session-turn";

export interface SessionStartRequest {
  requestId: string;
  smith: string;
  repository: string;
  worktree: string;
  beadId?: string | undefined;
  about?: ConversationObject[] | undefined;
  /** Resume identity and context are supplied only by the server. */
  launch: Omit<ClaudeSessionLaunch, "resumeSessionId" | "context">;
}
export interface SessionStartReceipt {
  session: OwnedSessionRecord;
  receipt: ConversationReceipt;
}
export interface SessionPreviewReceipt {
  projectId: string;
  requestId: string;
  snapshot: SessionTurnSnapshot;
  serialized: SerializedClaudeLaunch;
}
