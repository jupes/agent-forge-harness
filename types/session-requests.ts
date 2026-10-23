import type { ConversationObject, ConversationReceipt } from "./conversation";
import type { OwnedSessionRecord } from "./owned-session";
import type { ClaudeSessionLaunch } from "./session-launch";

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
