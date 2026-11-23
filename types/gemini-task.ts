/** Private request data. Trusted admission owns scope, original identity and launch authority. */
import type { ReportedJson, ReportedText } from "./session-activity";

export interface GeminiTaskLaunch {
  route: "gemini-cli";
  mode: "task";
  cwd: string;
  prompt: string;
  model?: string;
  approvalMode?: "default" | "auto_edit" | "plan";
  sandbox?: boolean;
  policyFiles?: readonly string[];
  includeDirectories?: readonly string[];
  context?: {
    projectId: string;
    repository: string;
    worktree: string;
    beadId?: string;
    about?: readonly {
      kind: "bead" | "session" | "run" | "event";
      id: string;
    }[];
  };
  attachments?: readonly { kind: "text"; name: string; text: string }[];
}

export interface GeminiTaskCapabilities {
  version: string;
  /** Native --help evidence, not authentication or exact-model access evidence. */
  flags: readonly string[];
}

export interface SerializedGeminiTask {
  argv: string[];
  stdin: string;
  inputFormat: "text";
  equivalentCommand: string;
  stdinNote: string;
  requiredFlags: string[];
}

export interface GeminiModelUsage {
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  uncachedInputTokens: number;
}
export interface GeminiTaskUsage extends GeminiModelUsage {
  durationMs: number;
  toolCalls: number;
  models: Record<string, GeminiModelUsage>;
}
export type GeminiTaskPrivateEvent =
  | {
      kind: "identity";
      provider: "gemini";
      route: "gemini-cli";
      version: string;
      sessionId: string;
      configuredModel: string;
    }
  | { kind: "text"; text: string; delta: boolean }
  | {
      kind: "tool";
      id: string;
      name: string;
      state: "requested" | "succeeded" | "failed";
      input?: ReportedJson;
      output?: ReportedText;
      error?: { type: string; message: ReportedText };
    }
  | {
      kind: "notice";
      severity: "warning" | "error";
      message: ReportedText;
      reportedType?: string;
    }
  | { kind: "usage"; usage: GeminiTaskUsage };

export interface GeminiTaskOutcome {
  phase: "completed" | "failed" | "unknown";
  reason: string | null;
  sessionId: string | null;
  configuredModel: string | null;
  /** Actual per-model usage is retained separately; init.model is not execution telemetry. */
  usage: GeminiTaskUsage | null;
}
