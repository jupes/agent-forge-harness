import { useEffect, useRef, useState } from "preact/hooks";
import { actionOutcome } from "../../../docs/js/action-outcome";
import { readHearth } from "../../../docs/js/hearth-read";
import { operatorPost, operatorRead } from "../../../docs/js/operator";
import { pageReads, readOperatorRoute } from "../../../docs/js/use-stream";
import { createKeeperSessionReviews } from "./keeper-session-review";
import type { SessionsClient } from "./session-client";

const base = (projectId: string, proposalId: string) =>
  `/projects/${encodeURIComponent(projectId)}/keeper/proposals/${encodeURIComponent(proposalId)}/session-start`;

export function useKeeperSessionReviews(
  writesAllowed: boolean,
  sessions: SessionsClient,
) {
  const writes = useRef(writesAllowed);
  writes.current = writesAllowed;
  const [, paint] = useState(0),
    held = useRef<ReturnType<typeof createKeeperSessionReviews> | null>(null);
  held.current ??= createKeeperSessionReviews({
    canWrite: () => writes.current,
    requestId: () => crypto.randomUUID(),
    read: (projectId, proposalId, requestId) =>
      readHearth(
        `/__agent-forge${base(projectId, proposalId)}${requestId ? `?${new URLSearchParams({ requestId })}` : ""}`,
        async (response) => {
          const raw: unknown = await response.json();
          if (
            !raw ||
            typeof raw !== "object" ||
            !("ok" in raw) ||
            !("data" in raw)
          )
            throw new Error(
              "The protected proposal read could not be verified.",
            );
          if (response.status === 404 && raw.ok === false && raw.data === null)
            return null;
          if (!response.ok || raw.ok !== true)
            throw new Error("The protected proposal Start could not be read.");
          return raw.data;
        },
        { ...pageReads(), fetch: operatorRead },
      ),
    post: (projectId, proposalId, body) =>
      actionOutcome(
        () =>
          operatorPost(`/__agent-forge${base(projectId, proposalId)}`, body),
        "Check the original proposal Start before retrying. The exact reviewed input is kept.",
      ),
    createWorktree: (projectId, body) =>
      actionOutcome(
        () =>
          operatorPost(
            `/__agent-forge/projects/${encodeURIComponent(projectId)}/session-worktrees`,
            body,
          ),
        "Check the original worktree request before retrying.",
      ),
    readWorktree: (projectId, requestId) =>
      readOperatorRoute(
        `/projects/${encodeURIComponent(projectId)}/session-worktrees/${encodeURIComponent(requestId)}`,
        { ...pageReads(), fetch: operatorRead },
      ),
    adopt: (projectId, input, raw) =>
      sessions.adoptStartReceipt(projectId, input, raw),
  });
  const client = held.current;
  useEffect(
    () => client.subscribe(() => paint((value) => value + 1)),
    [client],
  );
  useEffect(() => () => client.dispose(), [client]);
  return client;
}
