import type { ClaudeEffort } from "./session-launch";

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
}

/** A durable Start identity and journal address, never authority to dispatch a provider. */
export interface OwnedSessionRecord extends OwnedSessionMetadata {
  projectId: string;
  id: string;
  requestId: string;
  requestHash: string;
  createdAt: string;
}
