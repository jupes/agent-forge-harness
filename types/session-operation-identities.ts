/** Read-only, metadata-only index of owned session effect identities. */
import type { SessionStartIdentityMetadata } from "./session-start-identities";

export interface CodexChatForkIdentityMetadata {
  family: "codex-chat-fork";
  requestId: string;
  requestHash: string;
  parentSessionId: string;
  throughTurnRequestId: string;
  state: "reserved" | "attempted" | "captured" | "linked" | "held";
  /** Published only once the child is linked to a verified local record. */
  childSessionId?: string | undefined;
  heldReason?: "unknown-native-outcome" | "invalid-native-outcome" | undefined;
}

export type SessionOperationIdentity =
  | ({ family: "owned-session-start" } & SessionStartIdentityMetadata)
  | CodexChatForkIdentityMetadata;

export interface SessionOperationIdentityPage {
  version: 1;
  scope: {
    projectId: string;
    workspace: string;
  };
  operations: SessionOperationIdentity[];
}
