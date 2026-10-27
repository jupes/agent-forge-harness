import type {
  ConversationBinding,
  ConversationEvent,
  ConversationPhase,
  PreparedConversationSend,
} from "../../types/conversation";
import type { ProjectRecord } from "../../types/projects";

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
      smith?: string | undefined;
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

/** Safe to project to the ledger: no prompt, reply, read output or provider error. */
export interface ConversationUpdate {
  projectId: string;
  conversationId: string;
  revision: number;
  requestId: string;
  phase: ConversationPhase;
}
