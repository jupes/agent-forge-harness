import { geminiChatOutcome } from "./gemini-chat-presentation";
import type { SessionsClient } from "./session-client";
import { ownedSessionControls } from "./session-controls";

export interface GeminiChatDecisionAddress {
  projectId: string;
  sessionId: string;
  turnRequestId: string | null;
  actionable: boolean;
}

/** Read the mutable private owner at the point of projection/dispatch, not a previous render's boolean. */
export function geminiChatPermissionAddress(input: {
  projectId: string;
  sessionId: string;
  client: SessionsClient;
  writesAllowed: boolean;
  archived: boolean;
}): GeminiChatDecisionAddress {
  const view = input.client.session(input.projectId, input.sessionId),
    turn = view.page?.turns.at(-1),
    record = input.client
      .project(input.projectId)
      .records.find((item) => item.id === input.sessionId);
  const address = {
    projectId: input.projectId,
    sessionId: input.sessionId,
    turnRequestId: turn?.requestId ?? null,
    actionable: false,
  };
  if (
    !record ||
    record.projectId !== input.projectId ||
    record.provider !== "gemini" ||
    record.mode !== "chat"
  )
    return address;
  const controls = ownedSessionControls({
    record,
    page: view.page,
    loaded: view.loaded,
    live: view.live,
    pending: !!view.pending,
    stopping: !!view.stopping || view.stopPosting || view.stopUnknown,
    feedInterrupted: view.feedInterrupted,
    readError: view.readError,
  });
  address.actionable =
    input.writesAllowed &&
    !input.archived &&
    controls.permissions.available &&
    !!turn &&
    !geminiChatOutcome(view.page, turn.requestId);
  return address;
}
