/** Provider-reported private coding data. These fields grant no tool or operator authority. */
export interface ReportedText {
  text: string;
  truncated: boolean;
}
export interface ReportedJson {
  json: string;
  truncated: boolean;
  omitted?: "depth" | "nodes" | "size" | undefined;
}
export type CodingActivitySource =
  | "claude.assistant"
  | "claude.stream_event"
  | "claude.user"
  | "claude.result"
  | "codex.item.started"
  | "codex.item.updated"
  | "codex.item.completed";
export type CodingActivityState = "running" | "completed" | "failed";
export type CodingActivity =
  | { kind: "reasoning"; content: ReportedText; redacted: boolean }
  | {
      kind: "tool";
      toolId: string;
      name: string;
      state: CodingActivityState;
      input?: ReportedJson | undefined;
      output?: ReportedJson | undefined;
      error?: ReportedText | undefined;
    }
  | {
      kind: "command";
      command: ReportedText;
      state: CodingActivityState;
      output?: ReportedText | undefined;
      exitCode?: number | undefined;
    }
  | {
      kind: "files";
      state: CodingActivityState;
      changes: {
        path: string;
        operation: "add" | "delete" | "update";
        diff?: ReportedText | undefined;
        additions?: number | undefined;
        deletions?: number | undefined;
      }[];
      truncated: boolean;
    }
  | {
      kind: "plan";
      steps: {
        content: ReportedText;
        state: "incomplete" | "in-progress" | "completed";
      }[];
      truncated: boolean;
    }
  | { kind: "structured-output"; output: ReportedJson }
  | {
      kind: "permission-denials";
      denials: { toolId: string; name: string; input: ReportedJson }[];
      truncated: boolean;
    };
export interface CodingActivityEvent {
  kind: "coding-activity";
  provider: "claude" | "codex";
  version: string;
  id: string;
  source: CodingActivitySource;
  partial: boolean;
  activity: CodingActivity;
}
export type CodingOutcomeCode =
  | "completed"
  | "stopped"
  | "timed-out"
  | "provider-error"
  | "auth-error"
  | "rate-limited"
  | "cli-exit"
  | "protocol-error"
  | "storage-error";
export interface CodingOutcomeEvent {
  kind: "coding-outcome";
  provider: "claude" | "codex";
  version: string;
  code: CodingOutcomeCode;
  exitCode: number | null;
  timedOut: boolean;
  stopped: boolean;
  message: ReportedText | null;
  /** A supervisor-provided tail, never represented as the process's complete stderr. */
  stderrTail: ReportedText;
  reportedCode?: string | undefined;
  resetAt?: string | undefined;
}
export interface ClaudeCodingUsageEvent {
  kind: "coding-usage";
  provider: "claude";
  source: "claude.result";
  version: string;
  usage: {
    inputTokens?: number | undefined;
    outputTokens?: number | undefined;
    cacheReadInputTokens?: number | undefined;
    cacheCreationInputTokens?: number | undefined;
  };
  /** The provider reports an estimate restored/cumulated across resume, not this turn's bill. */
  cumulativeEstimateUsd?: number | undefined;
  durationMs?: number | undefined;
}
