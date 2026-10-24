import { useEffect, useRef, useState } from "preact/hooks";
import { actionOutcome } from "../../../docs/js/action-outcome";
import { NotSent, operatorPost, operatorRead } from "../../../docs/js/operator";
import {
  appStream,
  fetchTransport,
  pageReads,
  readOperatorRoute,
} from "../../../docs/js/use-stream";
import { createSessionsClient } from "./session-client";
import {
  createSessionStartIdentities,
  SESSION_START_IDENTITIES,
} from "./session-start-identities";

const base = (id: string) => `/projects/${encodeURIComponent(id)}/sessions`;
export function useSessions(
  projectId: string | null,
  sessionId: string | null,
  writesAllowed: boolean,
) {
  const writes = useRef(writesAllowed);
  writes.current = writesAllowed;
  const [, paint] = useState(0),
    held = useRef<ReturnType<typeof createSessionsClient> | null>(null);
  if (!held.current) {
    let storage: Storage | null = null;
    try {
      storage = window.localStorage;
    } catch {
      /* Refuse Start before sending. */
    }
    held.current = createSessionsClient({
      canWrite: () => writes.current,
      requestId: () => crypto.randomUUID(),
      identities: createSessionStartIdentities({
        storage,
        withLock: async (work) => {
          if (!navigator.locks)
            throw Error("Shared original Start identity lock is unavailable.");
          return navigator.locks.request(
            SESSION_START_IDENTITIES,
            { signal: AbortSignal.timeout(30_000) },
            work,
          );
        },
      }),
      list: (id) =>
        readOperatorRoute(base(id), { ...pageReads(), fetch: operatorRead }),
      read: (id, session, query) =>
        readOperatorRoute(
          `${base(id)}/${encodeURIComponent(session)}?${new URLSearchParams({ after: String(query.after), limit: "100", ...(query.requestId ? { requestId: query.requestId } : {}) })}`,
          { ...pageReads(), fetch: operatorRead },
        ),
      post: async (id, session, action, body) => {
        let notSent = false;
        const outcome = await actionOutcome(async () => {
          try {
            return await operatorPost(
              `/__agent-forge${base(id)}${action === "start" ? "" : `/${encodeURIComponent(session ?? "")}/${action}`}`,
              body,
            );
          } catch (error) {
            if (error instanceof NotSent) notSent = true;
            throw error;
          }
        }, "Check the original session request before trying again.");
        return outcome.state === "refused" && notSent
          ? { ...outcome, notSent: true }
          : outcome;
      },
      stream: (id, session) =>
        fetchTransport(
          `/__agent-forge${base(id)}/${encodeURIComponent(session)}/events`,
          { fetch: operatorRead },
        ),
      createWorktree: (id, input) =>
        actionOutcome(
          () =>
            operatorPost(
              `/__agent-forge/projects/${encodeURIComponent(id)}/session-worktrees`,
              input,
            ),
          "Check the original worktree request before trying again.",
        ),
      readWorktree: (id, requestId) =>
        readOperatorRoute(
          `/projects/${encodeURIComponent(id)}/session-worktrees/${encodeURIComponent(requestId)}`,
          { ...pageReads(), fetch: operatorRead },
        ),
    });
  }
  const client = held.current;
  useEffect(
    () => client.subscribe(() => paint((value) => value + 1)),
    [client],
  );
  useEffect(() => {
    const update = (event: StorageEvent) => {
      if (event.key === SESSION_START_IDENTITIES) client.refreshIdentities();
    };
    window.addEventListener("storage", update);
    return () => window.removeEventListener("storage", update);
  }, [client]);
  useEffect(() => {
    if (!projectId) return;
    void client.refresh(projectId);
    return appStream().watch(
      ["operator.action", "session.started", "session.ended"],
      () => {
        void client.refresh(projectId);
      },
    );
  }, [client, projectId]);
  useEffect(() => {
    client.activate(projectId, sessionId);
  }, [client, projectId, sessionId]);
  useEffect(() => () => client.dispose(), [client]);
  return client;
}
