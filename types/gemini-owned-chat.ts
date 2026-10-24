import type { ConversationReceipt } from "./conversation";
import type {
  GeminiChatLaunch,
  GeminiChatRuntimeEvent,
  PreparedGeminiChat,
} from "./gemini-chat-runtime";
import type {
  GeminiOwnedSessionMetadata,
  GeminiOwnedSessionRecord,
} from "./gemini-owned-task";
import type { SerializedGeminiTask } from "./gemini-task";
import type { ReportedJson } from "./session-activity";
import type { SessionStartRequest } from "./session-requests";

/** Explicit public intent; executable, native session and filesystem authority remain server-owned. */
export interface GeminiChatStartRequest
  extends Omit<SessionStartRequest, "launch"> {
  provider: "gemini";
  launch: Omit<
    GeminiChatLaunch,
    "cwd" | "context" | "policyFiles" | "includeDirectories"
  >;
}
export interface GeminiChatOwnedMetadata
  extends Omit<GeminiOwnedSessionMetadata, "mode"> {
  mode: "chat";
}
export interface GeminiChatOwnedRecord
  extends GeminiChatOwnedMetadata,
    Omit<GeminiOwnedSessionRecord, keyof GeminiOwnedSessionMetadata> {}
export interface GeminiChatStartReceipt {
  session: GeminiChatOwnedRecord;
  receipt: ConversationReceipt;
}
export interface GeminiChatPreviewReceipt {
  provider: "gemini";
  projectId: string;
  requestId: string;
  snapshot: PreparedGeminiChat;
  serialized: SerializedGeminiTask;
}
export interface GeminiChatPrivateFrame {
  kind: "coding-gemini-chat";
  provider: "gemini";
  version: "0.65.0";
  event:
    | GeminiChatRuntimeEvent
    | {
        kind: "approval-offer";
        id: string;
        requestId: string;
        rpcId: string | number;
        toolCallId: string;
      };
}
/** No native RPC, process or session selector crosses the decision boundary. Null means cancellation. */
export interface GeminiChatDecisionRequest {
  requestId: string;
  turnRequestId: string;
  approvalId: string;
  optionId: string | null;
}
/** A receipt confirms saved intent only, never delivery, execution or a reusable native grant. */
export interface GeminiChatDecisionReceipt extends GeminiChatDecisionRequest {
  projectId: string;
  sessionId: string;
  state: "recorded";
  recordedAt: string;
}
export interface GeminiChatDecisionIntent {
  kind: "coding-gemini-chat-decision";
  provider: "gemini";
  version: "0.65.0";
  requestHash: string;
  receipt: GeminiChatDecisionReceipt;
}
export interface GeminiChatApprovalPage {
  pending: Array<{
    turnRequestId: string;
    actionable: true;
    approval: {
      id: string;
      detail: ReportedJson;
      detailsComplete: boolean;
      options: {
        optionId: string;
        name: string;
        kind: "allow_once" | "reject_once";
      }[];
    };
  }>;
  receipt: GeminiChatDecisionReceipt | null;
}
