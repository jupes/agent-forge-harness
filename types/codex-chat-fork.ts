/** App-owned Codex native Fork identities. This is not an ordinary Start request. */
export interface CodexChatForkIntent {
  requestId: string;
  throughTurnRequestId: string;
}

/** Immutable, metadata-only provenance for a child created by native Fork. */
export interface CodexChatForkOrigin {
  kind: "codex-chat-fork";
  projectId: string;
  parentSessionId: string;
  throughTurnRequestId: string;
  parentTurnHash: string;
  parentNativeThreadId: string;
  throughNativeTurnId: string;
  childNativeThreadId: string;
  captureHash: string;
  protocolVersion: "0.163.0-alpha.10.2";
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
  /** Missing only on legacy rows; new coordinators never dispatch or adopt those rows. */
  sourceSeal?: CodexChatForkSourceSeal | undefined;
  /** Missing only on legacy rows; never inferred from a `reserved` state. */
  reservationKind?: CodexChatForkReservationKind | undefined;
  createdAt: string;
  updatedAt: string;
}

/** Resolver-derived immutable proof captured before a native effect is claimed. */
export interface CodexChatForkSourceSeal {
  parentRequestHash: string;
  parentTurnHash: string;
  parentNativeThreadId: string;
  throughNativeTurnId: string;
  sourceSettingsHash: string;
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
  | "sourceSeal"
  | "reservationKind"
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
    })
  | (CodexChatForkOriginalBase & {
      state: "retired";
      retiredReason: "verified-not-sent";
    });

/** Internal provenance for new reservation rows; never accepted from a route body. */
export type CodexChatForkReservationKind = "preflight-v1" | "direct-v1";

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
