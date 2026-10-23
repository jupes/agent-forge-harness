import type {
  CodexChatOwnedMetadata,
  CodexChatOwnedRecord,
  CodexChatStartReceipt,
  CodexChatStartRequest,
} from "./codex-owned-chat";
import type {
  CodexExecUsage,
  CodexTaskTextAttachment,
  SerializedCodexTask,
} from "./codex-task";
import type { PreparedCodexTask } from "./codex-task-runtime";
import type { ConversationReceipt } from "./conversation";
import type { OwnedSessionMetadata, OwnedSessionRecord } from "./owned-session";
import type {
  SessionPreviewReceipt,
  SessionStartReceipt,
  SessionStartRequest,
} from "./session-requests";

/** Additive public Task intent. Scope/context/cwd and prepared authority are supplied by the server. */
export interface CodexTaskStartRequest
  extends Omit<SessionStartRequest, "launch"> {
  provider: "codex";
  launch: {
    mode: "task";
    model: string;
    prompt: string;
    sandbox: "read-only" | "workspace-write";
    approvalPolicy: "never";
    effort?: string | undefined;
    attachments?: CodexTaskTextAttachment[] | undefined;
  };
}

/** The original untagged Claude request remains unchanged for saved UUID/hash compatibility. */
export type OwnedSessionStartRequest =
  | SessionStartRequest
  | CodexTaskStartRequest
  | CodexChatStartRequest;
export type OwnedSessionStartInput =
  | Omit<SessionStartRequest, "requestId">
  | Omit<CodexTaskStartRequest, "requestId">
  | Omit<CodexChatStartRequest, "requestId">;

export interface CodexOwnedSessionMetadata
  extends Omit<OwnedSessionMetadata, "provider" | "mode" | "requestedEffort"> {
  provider: "codex";
  mode: "task";
  requestedEffort: string | null;
}
export interface CodexOwnedSessionRecord
  extends CodexOwnedSessionMetadata,
    Omit<OwnedSessionRecord, keyof OwnedSessionMetadata> {}
export type OwnedCodingSessionRecord =
  | OwnedSessionRecord
  | CodexOwnedSessionRecord
  | CodexChatOwnedRecord;
export type OwnedCodingSessionMetadata =
  | OwnedSessionMetadata
  | CodexOwnedSessionMetadata
  | CodexChatOwnedMetadata;
export interface CodexTaskStartReceipt {
  session: CodexOwnedSessionRecord;
  receipt: ConversationReceipt;
}
export type OwnedCodingSessionStartReceipt =
  | SessionStartReceipt
  | CodexTaskStartReceipt
  | CodexChatStartReceipt;
export interface CodexTaskPreviewReceipt {
  provider: "codex";
  projectId: string;
  requestId: string;
  snapshot: PreparedCodexTask;
  serialized: SerializedCodexTask;
}
export type OwnedCodingSessionPreviewReceipt =
  | SessionPreviewReceipt
  | CodexTaskPreviewReceipt;

/** Reported counts in the owned coding journal only; no model, cost or allowance is inferred. */
export interface CodexCodingUsageEvent {
  kind: "coding-usage";
  provider: "codex";
  source: "exec.turn.completed";
  version: string;
  usage: CodexExecUsage;
}
