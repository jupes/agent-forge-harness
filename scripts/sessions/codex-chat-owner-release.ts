/** Internal read-only fold input; caller-derived scope is never accepted from a client. */
export interface CodexChatOwnerReleaseFoldInput {
  owner: unknown;
  state: unknown;
  projectId: string;
  conversationId: string;
  workspaceKey: string;
}

export type CodexChatOwnerReleaseFoldResult =
  | {
      eligible: true;
      turnRequestId: string;
      binding: {
        provider: "codex";
        sessionId: string;
        version: string;
        turnId: string;
      };
    }
  | { eligible: false; reason: "unavailable" };

/** Placeholder for the source-verified pure fold; no state is eligible yet. */
export function foldCodexChatOwnerRelease(
  _input: CodexChatOwnerReleaseFoldInput,
): CodexChatOwnerReleaseFoldResult {
  return { eligible: false, reason: "unavailable" };
}
