import type { CodexChatForkOrigin } from "../../types/codex-chat-fork";
import type { ProjectShiftAttemptOrigin } from "../../types/shift-origin";
import { ConversationError } from "../conversations/error";

/** Generic conversation stop markers are not the canonical shift engine's control channel. */
export function requireOrdinarySession(session: {
  origin?: ProjectShiftAttemptOrigin | CodexChatForkOrigin | undefined;
}): void {
  if (session.origin?.kind === "codex-chat-fork")
    throw new ConversationError(
      409,
      "This session is a native Codex Fork child. Ordinary Start, Send, Stop, archive and export are unavailable until Fork continuation is supported.",
    );
  if (session.origin)
    throw new ConversationError(
      409,
      "This private attempt belongs to a managed project shift. Read it through its original shift and use the shift's Stop or Recover controls.",
    );
}
