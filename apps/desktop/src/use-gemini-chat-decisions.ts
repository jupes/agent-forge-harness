import { useEffect, useRef, useState } from "preact/hooks";
import { actionOutcome } from "../../../docs/js/action-outcome";
import { operatorPost, operatorRead } from "../../../docs/js/operator";
import { pageReads, readOperatorRoute } from "../../../docs/js/use-stream";
import type { GeminiChatDecisionAddress } from "./gemini-chat-authority";
import {
  createGeminiChatDecisionIdentities,
  GEMINI_CHAT_DECISION_IDENTITIES,
} from "./gemini-chat-decision-identities";
import { createGeminiChatDecisions } from "./gemini-chat-decisions";

export function useGeminiChatDecisions(input: {
  projectId: string;
  sessionId: string;
  turnRequestId: string | null;
  enabled: boolean;
  actionable: boolean;
  approvalRevision: number;
  readCurrent(): GeminiChatDecisionAddress;
}) {
  const selection = useRef(input);
  selection.current = input;
  const [, paint] = useState(0),
    held = useRef<ReturnType<typeof createGeminiChatDecisions> | null>(null);
  if (!held.current) {
    let storage: Storage | null = null;
    try {
      storage = window.localStorage;
    } catch {
      /* Refuse before POST. */
    }
    const path = (project: string, session: string) =>
      `/projects/${encodeURIComponent(project)}/sessions/${encodeURIComponent(session)}`;
    held.current = createGeminiChatDecisions({
      canWrite: () => selection.current.actionable,
      current: () => {
        const now = selection.current;
        if (!now.enabled) return null;
        const fresh = now.readCurrent();
        return fresh.projectId === now.projectId &&
          fresh.sessionId === now.sessionId &&
          fresh.turnRequestId === now.turnRequestId
          ? fresh
          : { ...fresh, actionable: false };
      },
      requestId: () => crypto.randomUUID(),
      identities: createGeminiChatDecisionIdentities({
        storage,
        withLock: async (work) => {
          if (!navigator.locks)
            throw Error(
              "Shared original approval decision lock is unavailable.",
            );
          return navigator.locks.request(
            GEMINI_CHAT_DECISION_IDENTITIES,
            { signal: AbortSignal.timeout(30_000) },
            work,
          );
        },
      }),
      read: (project, session, requestId) =>
        readOperatorRoute(
          `${path(project, session)}/approvals${requestId ? `?requestId=${encodeURIComponent(requestId)}` : ""}`,
          { ...pageReads(), fetch: operatorRead },
        ),
      post: (project, session, body) =>
        actionOutcome(
          () =>
            operatorPost(
              `/__agent-forge${path(project, session)}/approval-decisions`,
              body,
            ),
          "Check the original approval decision receipt; do not choose another identity.",
        ),
    });
  }
  const client = held.current;
  useEffect(
    () => client.subscribe(() => paint((value) => value + 1)),
    [client],
  );
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === GEMINI_CHAT_DECISION_IDENTITIES)
        client.refreshIdentities();
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [client]);
  useEffect(() => {
    client.activate(
      input.enabled
        ? {
            projectId: input.projectId,
            sessionId: input.sessionId,
            turnRequestId: input.turnRequestId,
            actionable: input.actionable,
          }
        : null,
    );
    if (!input.enabled || !input.actionable) return;
    void client.refreshPending();
    const timer = setInterval(() => {
      void client.refreshPending();
    }, 5000);
    return () => clearInterval(timer);
  }, [
    client,
    input.enabled,
    input.projectId,
    input.sessionId,
    input.turnRequestId,
    input.actionable,
  ]);
  useEffect(() => {
    if (input.enabled && input.actionable && input.approvalRevision)
      void client.refreshPending();
  }, [client, input.approvalRevision, input.enabled, input.actionable]);
  useEffect(() => () => client.dispose(), [client]);
  return client;
}
