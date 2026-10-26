export interface SessionStartIdentityScope {
  family: "owned-session-start";
  projectId: string;
  workspace: string;
}

export interface SessionStartIdentityMetadata {
  version: 1;
  requestId: string;
  requestHash: string;
  provider: "claude" | "codex" | "gemini";
  mode: "task" | "chat";
  state: "reserved" | "attempted" | "not-sent" | "admitted" | "retired";
}

export interface SessionStartIdentityPage {
  version: 1;
  scope: SessionStartIdentityScope;
  identities: SessionStartIdentityMetadata[];
}

export interface SessionStartIdentityReply {
  version: 1;
  scope: SessionStartIdentityScope;
  identity: SessionStartIdentityMetadata;
}

export interface RetireSessionStartIdentity {
  requestHash: string;
}
