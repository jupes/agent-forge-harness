/** Task-only request data. Scope, allowance, executable and environment authority stay with the server. */
export interface CodexTaskLaunch {
  mode: "task";
  cwd: string;
  model: string;
  sandbox: "read-only" | "workspace-write";
  approvalPolicy: "never";
  prompt: string;
  effort?: string;
  attachments?: readonly CodexTaskTextAttachment[];
  context?: CodexTaskContext;
}

export interface CodexTaskTextAttachment {
  kind: "text";
  name: string;
  text: string;
}

/** Private prompt data, never evidence that these paths or references are authorized. */
export interface CodexTaskContext {
  projectId: string;
  repository: string;
  worktree: string;
  beadId?: string;
  about?: readonly {
    kind: "bead" | "session" | "run" | "event";
    id: string;
  }[];
}

/** Private, separately obtained catalog evidence for an exact execution model identifier. */
export interface CodexModelEffortEvidence {
  model: string;
  efforts: readonly string[];
  source: "model/list";
  cliVersion: string;
  asOf: string;
}

export interface CodexExecCapabilities {
  version: string;
  /** Observed exec help flags; these do not prove per-model effort, access or allowance. */
  flags: readonly string[];
  modelEfforts?: readonly CodexModelEffortEvidence[];
}

export interface SerializedCodexTask {
  argv: string[];
  stdin: string;
  inputFormat: "text";
  /** PowerShell argv rendering only. Supply private stdin separately; never parse this for execution. */
  equivalentCommand: string;
  stdinNote: string;
  requiredFlags: string[];
}

export interface CodexExecUsage {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  cacheWriteInputTokens?: number;
  reasoningOutputTokens?: number;
}

/** Private events only. They contain no tool bodies or inferred execution model. */
export type CodexExecPrivateEvent =
  | { kind: "identity"; provider: "codex"; threadId: string; version: string }
  | { kind: "text"; itemId: string; text: string }
  | { kind: "usage"; usage: CodexExecUsage };

export interface CodexExecOutcome {
  phase: "completed" | "failed" | "unknown";
  reason: string | null;
  threadId: string | null;
  /** Exec JSONL currently supplies no established per-turn model telemetry. */
  observedModel: null;
  usage: CodexExecUsage | null;
}
