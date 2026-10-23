import type {
  CodexChatApproval,
  CodexChatDecision,
  CodexChatEvent,
} from "./codex-chat";
import type {
  CodexOwnedSessionMetadata,
  CodexOwnedSessionRecord,
} from "./codex-owned-task";
import type { CodexTaskTextAttachment } from "./codex-task";
import type { ConversationReceipt } from "./conversation";
import type { SessionStartRequest } from "./session-requests";

/** Explicit browser intent. Native identities, paths and prepared authority are server-owned. */
export interface CodexChatStartRequest
  extends Omit<SessionStartRequest, "launch"> {
  provider: "codex";
  launch: {
    mode: "chat";
    model: string;
    prompt: string;
    sandbox: "read-only" | "workspace-write";
    approvalPolicy: "on-request" | "never";
    effort?: string | undefined;
    attachments?: CodexTaskTextAttachment[] | undefined;
  };
}
export interface CodexChatOwnedMetadata
  extends Omit<CodexOwnedSessionMetadata, "mode"> {
  mode: "chat";
}
export interface CodexChatOwnedRecord
  extends CodexChatOwnedMetadata,
    Omit<CodexOwnedSessionRecord, keyof CodexOwnedSessionMetadata> {}
export interface CodexChatStartReceipt {
  session: CodexChatOwnedRecord;
  receipt: ConversationReceipt;
}

/** No native RPC, process, thread or item selector crosses this public decision boundary. */
export interface CodexChatDecisionRequest {
  requestId: string;
  turnRequestId: string;
  approvalId: string;
  decision: CodexChatDecision;
}
/** Immutable confirmation of private intent only; never proof of a native write or execution. */
export interface CodexChatDecisionReceipt extends CodexChatDecisionRequest {
  projectId: string;
  sessionId: string;
  state: "recorded";
  recordedAt: string;
}
export interface CodexChatPrivateEvent {
  kind: "coding-chat";
  provider: "codex";
  version: string;
  event: CodexChatEvent;
}
export interface CodexChatDecisionIntent {
  kind: "coding-chat-decision";
  provider: "codex";
  version: string;
  requestHash: string;
  receipt: CodexChatDecisionReceipt;
}
export interface CodexChatApprovalPage {
  pending: Array<{
    turnRequestId: string;
    actionable: true;
    approval: Pick<
      CodexChatApproval,
      "id" | "kind" | "command" | "cwd" | "reason" | "availableDecisions"
    >;
  }>;
  receipt: CodexChatDecisionReceipt | null;
}
