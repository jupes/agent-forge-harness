import type {
  CodexExecUsage,
  CodexModelEffortEvidence,
  CodexTaskLaunch,
} from "./codex-task";
import type { ReportedText } from "./session-activity";

/** A private native report only; these paths and bodies grant no execution or approval authority. */
export interface CodexChatCommand {
  kind: "command";
  source:
    | "item/started"
    | "item/commandExecution/outputDelta"
    | "item/completed"
    | "turn/completed";
  threadId: string;
  turnId: string;
  itemId: string;
  command: ReportedText;
  cwd: string;
  status: "inProgress" | "completed" | "failed" | "declined";
  /** Delta reports carry only the newly retained portion; aggregate reports are distinct native facts. */
  output: ReportedText | null;
  outputSource: "delta" | "aggregate" | null;
  exitCode: number | null;
  durationMs: number | null;
  partial: boolean;
}

/** Private Chat intent. Scope, allowance, original request and execution authority remain server-owned. */
export interface CodexChatLaunch
  extends Omit<CodexTaskLaunch, "mode" | "approvalPolicy"> {
  mode: "chat";
  approvalPolicy: "on-request" | "never";
}

export interface CodexChatCapabilities {
  version: string;
  flags: readonly string[];
  modelEfforts?: readonly CodexModelEffortEvidence[];
}

export interface PreparedCodexChat {
  version: 1;
  provider: "codex";
  smith: string;
  cwd: string;
  canonicalCwd: string;
  launch: CodexChatLaunch;
  capabilities: CodexChatCapabilities;
}

/** Exact owned provider thread, never an implicit latest-session selector or history path. */
export interface CodexChatBinding {
  provider: "codex";
  threadId: string;
  version: string;
}

export type CodexChatDecision = "accept" | "decline" | "cancel";
/** Native usage scopes are explicit: neither value is an inferred per-turn aggregate. */
export interface CodexChatUsage {
  lastResponse: CodexExecUsage;
  threadTotal: CodexExecUsage;
}
export interface CodexChatApproval {
  id: string;
  provider: "codex";
  processId: number;
  nativeRequestId: string | number;
  nativeApprovalId: string | null;
  threadId: string;
  turnId: string;
  itemId: string;
  kind: "command" | "file-change";
  command: string | null;
  cwd: string | null;
  reason: string | null;
  availableDecisions: readonly CodexChatDecision[];
}

/** Separate private protocol; never accepted by sealed Keeper or existing Task codecs. */
export type CodexChatEvent =
  | {
      kind: "process";
      pid: number;
      wrapperPid: number;
      smith: string;
      requestedModel: string;
      requestedEffort: string | null;
    }
  | { kind: "identity"; provider: "codex"; threadId: string; version: string }
  | {
      kind: "configuration";
      model: string;
      modelProvider: string;
      effort: string | null;
      cwd: string;
    }
  | { kind: "turn"; threadId: string; turnId: string }
  | { kind: "text"; itemId: string; text: string }
  | CodexChatCommand
  | { kind: "usage"; usage: CodexChatUsage }
  | { kind: "outcome"; outcome: CodexChatOutcome }
  | { kind: "reroute"; fromModel: string; toModel: string; reason: string }
  | { kind: "approval-request"; approval: CodexChatApproval }
  | {
      kind: "approval-decision";
      approvalId: string;
      decision: CodexChatDecision;
    }
  | {
      kind: "approval-resolved";
      approvalId: string;
      source: "serverRequest/resolved" | "turn/completed";
    };

export interface CodexChatOutcome {
  phase: "completed" | "failed" | "unknown";
  reason: string | null;
  threadId: string | null;
  turnId: string | null;
  /** Thread configuration and model rerouting are not execution-model telemetry. */
  observedModel: null;
  usage: CodexChatUsage | null;
  exitCode: number | null;
  stopped: boolean;
  timedOut: boolean;
}
