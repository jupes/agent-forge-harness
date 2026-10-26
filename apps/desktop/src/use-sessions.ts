import { useEffect, useRef, useState } from "preact/hooks";
import { actionOutcome } from "../../../docs/js/action-outcome";
import { NotSent, operatorPost, operatorRead } from "../../../docs/js/operator";
import {
  appStream,
  fetchTransport,
  pageReads,
  readOperatorRoute,
} from "../../../docs/js/use-stream";
import type { ProviderReadinessPage } from "../../../types/provider-readiness";
import { createSessionsClient } from "./session-client";
import { createSessionStartIdentityServer } from "./session-start-identity-server";

const base = (id: string) => `/projects/${encodeURIComponent(id)}/sessions`;
export function useSessions(
  projectId: string | null,
  sessionId: string | null,
  writesAllowed: boolean,
  readiness: ProviderReadinessPage | null,
) {
  const writes = useRef(writesAllowed);
  writes.current = writesAllowed;
  const scope = useRef<{
    projectId: string;
    workspace: string;
    generation: number;
  } | null>(null);
  const scopeVersion = useRef(-1);
  const scopeKey = useRef<string | null>(null);
  const currentWorkspace = readiness?.workspace ?? null;
  const currentProject = projectId;
  const nextScopeKey =
    currentProject && currentWorkspace
      ? JSON.stringify([currentProject, currentWorkspace])
      : null;
  if (scopeKey.current !== nextScopeKey) {
    scopeKey.current = nextScopeKey;
    scopeVersion.current++;
    scope.current =
      currentProject && currentWorkspace
        ? {
            projectId: currentProject,
            workspace: currentWorkspace,
            generation: scopeVersion.current,
          }
        : null;
  }
  const [, paint] = useState(0),
    held = useRef<ReturnType<typeof createSessionsClient> | null>(null);
  if (!held.current) {
    held.current = createSessionsClient({
      canWrite: () => writes.current,
      requestId: () => crypto.randomUUID(),
      identityServer: createSessionStartIdentityServer({
        currentScope: () => scope.current,
        read: operatorRead,
        post: operatorPost,
      }),
      identityScope: () => scope.current,
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
    client.identityScopeChanged();
    if (projectId && scope.current) void client.refreshIdentities(projectId);
  }, [client, projectId, currentWorkspace]);
  useEffect(() => {
    if (!projectId) return;
    void client.refresh(projectId);
    return appStream().watch(
      ["operator.action", "session.started", "session.ended"],
      () => {
        void client.refresh(projectId);
        client.refreshIdentities(projectId);
      },
    );
  }, [client, projectId, currentWorkspace]);
  useEffect(() => {
    client.activate(projectId, sessionId);
  }, [client, projectId, sessionId]);
  useEffect(() => () => client.dispose(), [client]);
  return client;
}
