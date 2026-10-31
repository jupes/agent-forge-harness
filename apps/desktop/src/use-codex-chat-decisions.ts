import { useEffect, useState } from "preact/hooks";
import type { ChatDecisionOwners } from "./chat-decision-owners";

/** Subscribe to the app-root Codex owner; conversation unmount never disposes it. */
export function useCodexChatDecisions(input: {
  owners: ChatDecisionOwners;
  projectId: string;
  workspace: string | null;
  sessionId: string;
  turnRequestId: string | null;
  enabled: boolean;
  actionable: boolean;
  approvalRevision: number;
}) {
  const client = input.owners.codex;
  const [, paint] = useState(0);
  useEffect(
    () => client.subscribe(() => paint((value) => value + 1)),
    [client],
  );
  useEffect(() => {
    const active =
      input.enabled && input.workspace && input.turnRequestId
        ? {
            projectId: input.projectId,
            workspace: input.workspace,
            sessionId: input.sessionId,
            acceptedTurnId: input.turnRequestId,
            requestId: null,
            turnRequestId: input.turnRequestId,
            actionable: input.actionable,
          }
        : null;
    client.activate(active);
    if (!active?.actionable) return;
    void client.refreshPending();
    const timer = setInterval(() => void client.refreshPending(), 5000);
    return () => {
      clearInterval(timer);
    };
  }, [
    client,
    input.enabled,
    input.projectId,
    input.workspace,
    input.sessionId,
    input.turnRequestId,
    input.actionable,
  ]);
  useEffect(() => {
    if (input.enabled && input.actionable && input.approvalRevision)
      void client.refreshPending();
  }, [client, input.approvalRevision, input.enabled, input.actionable]);
  return client;
}
