/** Transcript bodies belong to private session storage, never LedgerEventInput. */
export interface ConversationObject {
  kind: "bead" | "session" | "run" | "event";
  id: string;
}

export interface ConversationSend {
  requestId: string;
  expectedRevision: number;
  text: string;
  about: ConversationObject[];
}

export type ConversationPhase =
  | "accepted"
  | "running"
  | "cancelling"
  | "completed"
  | "cancelled"
  | "failed"
  | "unknown";

export interface ConversationTurn {
  requestId: string;
  hash: string;
  phase: ConversationPhase;
  createdAt: string;
  updatedAt: string;
  reason: string | null;
  owner: string | null;
}

export interface ConversationBinding {
  provider: "claude" | "codex" | "gemini" | "grok";
  sessionId: string;
  version: string;
}

export type ConversationEvent =
  | { kind: "user"; text: string; about: ConversationObject[] }
  | ({ kind: "identity" } & ConversationBinding)
  | { kind: "text"; text: string };

export interface ConversationFrame {
  seq: number;
  turnId: string;
  at: string;
  event: ConversationEvent;
}

export interface ConversationState {
  version: 1;
  projectId: string;
  conversationId: string;
  revision: number;
  binding: ConversationBinding | null;
  turns: ConversationTurn[];
  frames: ConversationFrame[];
}

export interface ConversationReceipt {
  conversationId: string;
  revision: number;
  turn: ConversationTurn;
}
