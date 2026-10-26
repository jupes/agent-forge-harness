/** App-owned Codex native Fork identities. This is not an ordinary Start request. */
export interface CodexChatForkIntent {
  requestId: string;
  throughTurnRequestId: string;
}

export interface CodexChatForkOriginalBase {
  projectId: string;
  workspaceKey: string;
  requestId: string;
  requestHash: string;
  parentSessionId: string;
  throughTurnRequestId: string;
  protocolVersion: "0.163.0-alpha.10.2";
  childAppSessionId: string;
  createdAt: string;
  updatedAt: string;
}

export type CodexChatForkOriginalRef = Pick<
  CodexChatForkOriginalBase,
  | "projectId"
  | "workspaceKey"
  | "requestId"
  | "requestHash"
  | "parentSessionId"
  | "throughTurnRequestId"
  | "protocolVersion"
  | "childAppSessionId"
>;

export type CodexChatForkOriginal =
  | (CodexChatForkOriginalBase & { state: "reserved" | "attempted" })
  | (CodexChatForkOriginalBase & {
      state: "captured";
      capture: CodexChatForkCapture;
    })
  | (CodexChatForkOriginalBase & {
      state: "linked";
      capture: CodexChatForkCapture;
      link: CodexChatForkLink;
    })
  | (CodexChatForkOriginalBase & {
      state: "held";
      heldReason: CodexChatForkHeldReason;
    });

/** Persisted only after a later trusted coordinator verifies native Fork evidence. */
export interface CodexChatForkCapture {
  parentNativeThreadId: string;
  childNativeThreadId: string;
  throughNativeTurnId: string;
  protocolVersion: "0.163.0-alpha.10.2";
}

/** Internal link claim; only a future trusted coordinator may supply verified registry proof. */
export interface CodexChatForkLink {
  childAppSessionId: string;
  childRequestId: string;
  childRequestHash: string;
  captureHash: string;
}

export type CodexChatForkHeldReason =
  | "unknown-native-outcome"
  | "invalid-native-outcome";
