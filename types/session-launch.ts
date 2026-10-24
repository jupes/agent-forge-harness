/** A serializer input, never execution authority or proof of project/path membership. */
export type ClaudeEffort = "low" | "medium" | "high" | "xhigh" | "max";

export type SessionAttachment =
  | { kind: "text"; name: string; text: string }
  | {
      kind: "image";
      name: string;
      mediaType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
      data: string;
    };

/** Opaque context travels as user data; the server must independently validate its scope. */
export interface SessionLaunchContext {
  projectId: string;
  repository: string;
  worktree: string;
  beadId?: string | undefined;
  about?:
    | { kind: "bead" | "session" | "run" | "event"; id: string }[]
    | undefined;
}

export interface ClaudeSessionLaunch {
  mode: "task" | "chat";
  /** Only an actual, previously observed Claude identity may be supplied by the server. */
  resumeSessionId?: string | undefined;
  model: string;
  effort?: ClaudeEffort | undefined;
  permissionMode?: "acceptEdits" | "plan" | undefined;
  prompt: string;
  attachments?: SessionAttachment[] | undefined;
  context?: SessionLaunchContext | undefined;
  fallbackModels?: string[] | undefined;
  /** These paths must already have been approved and checked by the server. */
  extraDirectories?: string[] | undefined;
  maxBudgetUsd?: number | undefined;
  outputSchema?: Record<string, unknown> | undefined;
}

export interface ClaudeLaunchCapabilities {
  /** Observed with a bounded, model-free version/help probe, not an authentication claim. */
  version: string;
  flags: readonly string[];
  /** Separate provider evidence about each exact model, never inferred from help/aliases. */
  modelEfforts?: Readonly<Record<string, readonly ClaudeEffort[]>> | undefined;
}

export interface SerializedClaudeLaunch {
  /** Append to the trusted, server-resolved executable; never run through a shell. */
  argv: string[];
  stdin: string;
  inputFormat: "text" | "stream-json";
  /** PowerShell preview; private stdin/schema must be restored as stdinNote explains. Never parse this for execution. */
  equivalentCommand: string;
  stdinNote: string;
  requiredFlags: string[];
}
