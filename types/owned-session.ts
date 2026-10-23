import type { ClaudeEffort } from "./session-launch";
import type { ProjectShiftAttemptOrigin } from "./shift-turn";

/** Trusted launch metadata only; private prompts and serialized requests stay in the journal. */
export interface OwnedSessionMetadata {
  mode: "task" | "chat";
  provider: "claude";
  workspace: string;
  repository: string;
  worktree: string;
  beadId?: string | undefined;
  smith: string;
  requestedModel: string;
  requestedEffort: ClaudeEffort | null;
  origin?: ProjectShiftAttemptOrigin | undefined;
}

/** A durable Start identity and journal address, never authority to dispatch a provider. */
export interface OwnedSessionRecord extends OwnedSessionMetadata {
  projectId: string;
  id: string;
  requestId: string;
  requestHash: string;
  createdAt: string;
}
