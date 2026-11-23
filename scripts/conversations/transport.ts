import type {
  ConversationBinding,
  ConversationEvent,
  ConversationPhase,
  PreparedConversationSend,
} from "../../types/conversation";
import type { Smith } from "../../types/hearth";
import type { ProjectRecord } from "../../types/projects";

/** A source-sealed Keeper selection changed before any provider process started. */
export class KeeperSelectionMismatchError extends Error {
  constructor() {
    super(
      "The Keeper selection changed after this brief was reviewed. Review a new brief before dispatch.",
    );
    this.name = "KeeperSelectionMismatchError";
  }
}

/** Separate from EventSink: this channel owns private transcript bodies. */
export interface ConversationTransport {
  provider: ConversationBinding["provider"];
  /** Read-only capability check; it must never start a model turn. */
  check?(request: {
    project: ProjectRecord;
    root: string;
    resume: ConversationBinding | null;
    /** Trusted saved Keeper selection, never a model argument or public Send field. */
    smith?: string | undefined;
    /** Internal pin for an explicitly reviewed Keeper brief, never wire input. */
    expectedSmith?: Smith | undefined;
  }): Promise<void>;
  /** Settles only after the supervised process tree stops, including on error/abort. */
  run(
    request: {
      project: ProjectRecord;
      root: string;
      input: PreparedConversationSend;
      resume: ConversationBinding | null;
      /** Private per-call settings for a source-sealed Fork child resume. */
      codexResumeSettings?:
        | {
            modelProvider: string;
            serviceTier: string | null;
            reasoningEffort: string | null;
          }
        | undefined;
      /** Private app-owned ordinary Chat receipt sink; never sent to the provider. */
      ownerLifecycle?: CodexChatOwnerLifecycleSink | undefined;
      smith?: string | undefined;
      /** Internal pin for an explicitly reviewed Keeper brief, never wire input. */
      expectedSmith?: Smith | undefined;
    },
    persist: (
      event: Exclude<ConversationEvent, { kind: "user" }>,
    ) => Promise<void>,
    signal: AbortSignal,
  ): Promise<{
    phase: "completed" | "failed" | "unknown";
    reason: string | null;
  }>;
}

export interface CodexChatOwnerLifecycleSink {
  started(generationId: string): Promise<void>;
  released(
    generationId: string,
    binding: {
      provider: "codex";
      sessionId: string;
      version: string;
      turnId: string;
    },
  ): Promise<void>;
}

/** Safe to project to the ledger: no prompt, reply, read output or provider error. */
export interface ConversationUpdate {
  projectId: string;
  conversationId: string;
  revision: number;
  requestId: string;
  phase: ConversationPhase;
}
