/** Private ACP activity. Session notifications have no native accepted-turn identifier. */
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
