/** Metadata-only provenance, supplied exclusively by the trusted shift runtime. */
export interface ProjectShiftAttemptOrigin {
  kind: "shift";
  projectId: string;
  originalRequestId: string;
  shiftId: string;
  runId: string;
  beadId: string;
  attempt: number;
}

/** Private immutable input for one canonical provider attempt in a reviewed project shift. */
export interface ShiftTurnSnapshot
  extends Omit<ProjectShiftAttemptOrigin, "kind"> {
  version: 1;
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
