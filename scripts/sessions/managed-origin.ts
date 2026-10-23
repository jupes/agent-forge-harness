import type { ProjectShiftAttemptOrigin } from "../../types/shift-origin";
import { ConversationError } from "../conversations/error";

/** Generic conversation stop markers are not the canonical shift engine's control channel. */
export function requireOrdinarySession(session: {
  origin?: ProjectShiftAttemptOrigin | undefined;
}): void {
  if (session.origin)
    throw new ConversationError(
      409,
      "This private attempt belongs to a managed project shift. Read it through its original shift and use the shift's Stop or Recover controls.",
    );
}
