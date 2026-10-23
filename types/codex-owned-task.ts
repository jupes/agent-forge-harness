import type { CodexExecUsage, CodexTaskTextAttachment } from "./codex-task";
import type { ConversationReceipt } from "./conversation";
import type { OwnedSessionMetadata, OwnedSessionRecord } from "./owned-session";
import type { SessionStartRequest } from "./session-requests";

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
  | CodexTaskStartRequest;

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
  | CodexOwnedSessionRecord;
export type OwnedCodingSessionMetadata =
  | OwnedSessionMetadata
  | CodexOwnedSessionMetadata;
export interface CodexTaskStartReceipt {
  session: CodexOwnedSessionRecord;
  receipt: ConversationReceipt;
}

/** Reported counts in the owned coding journal only; no model, cost or allowance is inferred. */
export interface CodexCodingUsageEvent {
  kind: "coding-usage";
  provider: "codex";
  source: "exec.turn.completed";
  version: string;
  usage: CodexExecUsage;
}
