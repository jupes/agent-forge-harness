import type {
  ConversationPage,
  ConversationState,
} from "../../types/conversation";
import { ConversationError } from "./error";

export interface ConversationPageQuery {
  after?: number;
  limit?: number;
  requestId?: string;
}

export function validateConversationPageQuery(
  query: ConversationPageQuery,
): void {
  if (
    !Number.isSafeInteger(query.after ?? 0) ||
    (query.after ?? 0) < 0 ||
    !Number.isInteger(query.limit ?? 100) ||
    (query.limit ?? 100) < 1 ||
    (query.limit ?? 100) > 100
  )
    throw new ConversationError(
      400,
      "Expected a nonnegative cursor and a page size from 1 to 100.",
    );
}

/** Pure replay slicing; the caller supplies its already verified state and actual control authority. */
export function conversationPage(
  state: ConversationState,
  query: ConversationPageQuery,
  controllable: boolean,
): ConversationPage {
  validateConversationPageQuery(query);
  const after = query.after ?? 0;
  const frames = state.frames
    .filter((frame) => frame.seq > after)
    .slice(0, query.limit ?? 100);
  const nextCursor = frames.at(-1)?.seq ?? after;
  return {
    ...state,
    ...(state.keeperRecovery
      ? {
          keeperRecovery: {
            smith: state.keeperRecovery.smith,
            generation: state.keeperRecovery.generation,
            continuation: state.keeperRecovery.continuation,
          },
        }
      : {}),
    turns: state.turns.slice(-50),
    frames,
    more: state.frames.some((frame) => frame.seq > nextCursor),
    nextCursor,
    lastSequence: state.frames.at(-1)?.seq ?? 0,
    request:
      state.turns.find((item) => item.requestId === query.requestId) ?? null,
    controllable,
  };
}
