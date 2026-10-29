import type { ClaudeAccountReport } from "./claude-account";
import type { PreparedCodexChat } from "./codex-chat";
import type {
  CodexChatDecisionIntent,
  CodexChatPrivateEvent,
} from "./codex-owned-chat";
import type { CodexCodingUsageEvent } from "./codex-owned-task";
import type { PreparedCodexTask } from "./codex-task-runtime";
import type { PreparedGeminiChat } from "./gemini-chat-runtime";
import type {
  GeminiChatDecisionIntent,
  GeminiChatPrivateFrame,
} from "./gemini-owned-chat";
import type { GeminiTaskPrivateFrame } from "./gemini-owned-task";
import type { PreparedGeminiTask } from "./gemini-task-runtime";
import type { KeeperReadKind } from "./keeper";
import type {
  KeeperBriefIntentHistory,
  KeeperBriefSnapshot,
} from "./keeper-brief";
import type { KeeperRecoveryState } from "./keeper-recovery";
import type {
  ClaudeCodingUsageEvent,
  CodingActivityEvent,
  CodingOutcomeEvent,
} from "./session-activity";
import type { SessionTurnSnapshot } from "./session-turn";
import type { ShiftTurnSnapshot } from "./shift-turn";

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
  codexChat?: PreparedCodexChat | undefined;
  geminiTask?: PreparedGeminiTask | undefined;
  geminiChat?: PreparedGeminiChat | undefined;
  shift?: ShiftTurnSnapshot | undefined;
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

/** Private application lifecycle facts for one ordinary owned Codex Chat turn. */
export type CodexChatOwnerLifecycleFact =
  | {
      kind: "generation-started";
      requestId: string;
      generationId: string;
      afterSequence: number;
      revision: number;
    }
  | {
      kind: "generation-released";
      requestId: string;
      generationId: string;
      afterSequence: number;
      revision: number;
      binding: {
        provider: "codex";
        sessionId: string;
        version: string;
        turnId: string;
      };
    };

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
      codexChat?: PreparedCodexChat | undefined;
      geminiTask?: PreparedGeminiTask | undefined;
      geminiChat?: PreparedGeminiChat | undefined;
      shift?: ShiftTurnSnapshot | undefined;
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
  | CodexCodingUsageEvent
  | ClaudeCodingUsageEvent
  | CodingActivityEvent
  | ClaudeAccountReport
  | CodingOutcomeEvent
  | CodexChatPrivateEvent
  | CodexChatDecisionIntent
  | GeminiTaskPrivateFrame
  | GeminiChatPrivateFrame
  | GeminiChatDecisionIntent;

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
  /** Private owned-chat receipt facts; public pages and exports omit this field. */
  codexChatOwnerLifecycle?: CodexChatOwnerLifecycleFact[] | undefined;
  keeperRecovery?: KeeperRecoveryState | undefined;
  /** Exact private Keeper brief review originals; public pages and feeds omit this field. */
  keeperBriefIntents?: KeeperBriefIntentHistory | undefined;
}

export interface ConversationReceipt {
  conversationId: string;
  revision: number;
  turn: ConversationTurn;
}

export interface ConversationPage
  extends Omit<
    ConversationState,
    "keeperRecovery" | "codexChatOwnerLifecycle" | "keeperBriefIntents"
  > {
  keeperRecovery?: Omit<KeeperRecoveryState, "records"> | undefined;
  more: boolean;
  nextCursor: number;
  lastSequence: number;
  request: ConversationTurn | null;
  controllable: boolean;
}
