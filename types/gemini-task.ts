/** Private request data. Trusted admission owns scope, original identity and launch authority. */
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
