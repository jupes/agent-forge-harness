import type { GeminiAcpEvent, GeminiAcpUsage } from "./gemini-acp";
import type { GeminiTaskCapabilities, GeminiTaskLaunch } from "./gemini-task";
import type { ReportedText } from "./session-activity";

export interface GeminiChatLaunch extends Omit<GeminiTaskLaunch, "mode"> {
  mode: "chat";
}
/** A private frozen selection; trusted admission still owns scope, originals and retry authority. */
export interface PreparedGeminiChat {
  version: 1;
  provider: "gemini";
  smith: string;
  canonicalRoot: string;
  canonicalCwd: string;
  command: readonly string[];
  paths: readonly string[];
  launch: GeminiChatLaunch;
  capabilities: GeminiTaskCapabilities;
}
export type GeminiChatPermissionOffer = Extract<
  GeminiAcpEvent,
  { kind: "permission" }
> & {
  processId: number;
  sessionId: string;
};
export interface GeminiChatOutcome {
  phase: "completed" | "failed" | "unknown";
  reason: string | null;
  sessionId: string | null;
  stopReason: Extract<GeminiAcpEvent, { kind: "result" }>["stopReason"] | null;
  usage: GeminiAcpUsage | null;
}
export type GeminiChatRuntimeEvent =
  | GeminiAcpEvent
  | {
      kind: "process";
      pid: number;
      bootstrapPid: number;
      smith: string;
      requestId: string;
    }
  | {
      kind: "permission-intent";
      requestId: string;
      decisionRequestId: string;
      rpcId: string | number;
      toolCallId: string;
      optionId: string | null;
    }
  | {
      kind: "outcome";
      outcome: GeminiChatOutcome;
      exitCode: number | null;
      stopped: boolean;
      timedOut: boolean;
      stderr: ReportedText;
    };
