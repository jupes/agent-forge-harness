/** Private ACP activity. Session notifications have no native accepted-turn identifier. */
import type { ReportedJson, ReportedText } from "./session-activity";

export interface GeminiAcpUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedReadTokens?: number;
  thoughtTokens?: number;
}
export type GeminiAcpEvent =
  | { kind: "identity"; sessionId: string; resumed: boolean }
  | {
      kind: "text";
      text: string;
      role: "assistant" | "user";
      scope: "turn" | "native-session";
      requestId: string | null;
    }
  | { kind: "context"; usedTokens: number; contextTokens: number }
  | {
      kind: "error";
      requestId: string | null;
      code: number;
      message: ReportedText;
    }
  | {
      kind: "tool";
      toolCallId: string;
      status: "pending" | "in_progress" | "completed" | "failed";
      scope: "turn" | "native-session";
      requestId: string | null;
      detail: ReportedJson;
    }
  | {
      kind: "permission";
      rpcId: string | number;
      requestId: string;
      toolCallId: string;
      detail: ReportedJson;
      detailsComplete: boolean;
      options: {
        optionId: string;
        name: string;
        kind: "allow_once" | "reject_once";
      }[];
    }
  | {
      kind: "result";
      requestId: string;
      stopReason:
        | "end_turn"
        | "max_tokens"
        | "max_turn_requests"
        | "refusal"
        | "cancelled";
      usage: GeminiAcpUsage | null;
    };
