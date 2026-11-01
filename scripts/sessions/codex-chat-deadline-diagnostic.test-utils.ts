import type { CodexChatOutcome } from "../../types/codex-chat";

export type SafeCodexDeadlineOutcome = {
  state: "observed";
  phase: CodexChatOutcome["phase"];
  timedOut: boolean | null;
  stopped: boolean | null;
  exitCode: "null" | "zero" | "nonzero" | "invalid";
  reasonPresent: boolean | null;
};

export type CodexDeadlineDiagnosticFacts = {
  runtimeOutcome: SafeCodexDeadlineOutcome | { state: "missing" };
};

export function projectCodexDeadlineFacts(input: {
  runtimeOutcome: CodexChatOutcome | null;
}): CodexDeadlineDiagnosticFacts | null {
  void input;
  return null;
}
