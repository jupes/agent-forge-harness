import type {
  ConversationBinding,
  ConversationEvent,
  ConversationPhase,
  ConversationSend,
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
  }): Promise<void>;
  /** Settles only after the supervised process tree stops, including on error/abort. */
  run(
    request: {
      project: ProjectRecord;
      root: string;
      input: ConversationSend;
      resume: ConversationBinding | null;
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
