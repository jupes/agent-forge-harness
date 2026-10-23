import type { CodexCodingUsageEvent } from "./codex-owned-task";
import type { PreparedCodexTask } from "./codex-task-runtime";
import type { KeeperReadKind } from "./keeper";
import type { KeeperBriefSnapshot } from "./keeper-brief";
import type { KeeperRecoveryState } from "./keeper-recovery";
import type { SessionTurnSnapshot } from "./session-turn";

/** A trusted server-selected journal partition, separate from the provider's resume identity. */
export interface OwnedConversationAddress {
  kind: "session";
  projectId: string;
  sessionId: string;
}

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
/** Only trusted hearth preparation supplies this private intent, never a wire message. */
export interface PreparedConversationSend extends ConversationSend {
  brief?: KeeperBriefSnapshot | undefined;
  session?: SessionTurnSnapshot | undefined;
  codexTask?: PreparedCodexTask | undefined;
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
  | {
      kind: "user";
      text: string;
      about: ConversationObject[];
      brief?: KeeperBriefSnapshot | undefined;
      session?: SessionTurnSnapshot | undefined;
      codexTask?: PreparedCodexTask | undefined;
    }
  | ({ kind: "identity" } & ConversationBinding)
  | { kind: "text"; text: string; messageId?: string | undefined }
  | {
      kind: "process";
      pid: number;
      smith: string;
      requestedModel: string;
      requestedEffort: string;
    }
  | { kind: "model"; model: string }
  | {
      kind: "read";
      query: KeeperReadKind;
      source: string;
      asOf: string;
      complete: boolean;
      reason: string | null;
      ids: string[];
      nextCursor: number | null;
    }
  | {
      kind: "context";
      used: number | null;
      capacity: number | null;
      basis: "reported" | "estimated" | "unknown";
      source: string;
      asOf: string;
    }
  | CodexCodingUsageEvent;

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
  keeperRecovery?: KeeperRecoveryState | undefined;
}

export interface ConversationReceipt {
  conversationId: string;
  revision: number;
  turn: ConversationTurn;
}

export interface ConversationPage
  extends Omit<ConversationState, "keeperRecovery"> {
  keeperRecovery?: Omit<KeeperRecoveryState, "records"> | undefined;
  more: boolean;
  nextCursor: number;
  lastSequence: number;
  request: ConversationTurn | null;
  controllable: boolean;
}
