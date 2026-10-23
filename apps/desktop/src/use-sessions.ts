import { useEffect, useRef, useState } from "preact/hooks";
import { actionOutcome } from "../../../docs/js/action-outcome";
import { operatorPost, operatorRead } from "../../../docs/js/operator";
import {
  appStream,
  fetchTransport,
  pageReads,
  readOperatorRoute,
} from "../../../docs/js/use-stream";
import { createSessionsClient } from "./session-client";

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
  held.current ??= createSessionsClient({
    canWrite: () => writes.current,
    requestId: () => crypto.randomUUID(),
    list: (id) =>
      readOperatorRoute(base(id), { ...pageReads(), fetch: operatorRead }),
    read: (id, session, query) =>
      readOperatorRoute(
        `${base(id)}/${encodeURIComponent(session)}?${new URLSearchParams({ after: String(query.after), limit: "100", ...(query.requestId ? { requestId: query.requestId } : {}) })}`,
        { ...pageReads(), fetch: operatorRead },
      ),
    post: (id, session, action, body) =>
      actionOutcome(
        () =>
          operatorPost(
            `/__agent-forge${base(id)}${action === "start" ? "" : `/${encodeURIComponent(session ?? "")}/${action}`}`,
            body,
          ),
        "Check the original session request before trying again.",
      ),
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
  const client = held.current;
  useEffect(
    () => client.subscribe(() => paint((value) => value + 1)),
    [client],
  );
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
