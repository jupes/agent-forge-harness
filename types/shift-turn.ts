/** Private immutable input for one canonical provider attempt in a reviewed project shift. */
export interface ShiftTurnSnapshot {
  version: 1;
  projectId: string;
  originalRequestId: string;
  shiftId: string;
  runId: string;
  beadId: string;
  attempt: number;
  conversationId: string;
  turnId: string;
  provider: "claude" | "codex";
  cliVersion: string;
  workspace: string;
  cwd: string;
  smith: string;
  requestedModel: string;
  requestedEffort: string;
  command: string[];
  stdin: string;
  timeoutMs: number;
}
