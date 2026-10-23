import { useEffect, useRef, useState } from "preact/hooks";
import { actionOutcome } from "../../../docs/js/action-outcome";
import { operatorPost, operatorRead } from "../../../docs/js/operator";
import {
  fetchTransport,
  pageReads,
  readOperatorRoute,
} from "../../../docs/js/use-stream";
import { createKeeperClient } from "./keeper-client";

/** App lifetime, rather than route/drawer lifetime, owns pending requests and drafts. */
export function useKeeper(projectId: string | null, writesAllowed: boolean) {
  const writes = useRef(writesAllowed);
  writes.current = writesAllowed;
  const [, paint] = useState(0);
  const client = useRef<ReturnType<typeof createKeeperClient> | null>(null);
  client.current ??= createKeeperClient({
    canWrite: () => writes.current,
    requestId: () => crypto.randomUUID(),
    readRecovery: (id, requestId) =>
      readOperatorRoute(
        `/projects/${encodeURIComponent(id)}/keeper/recovery${requestId ? `?requestId=${encodeURIComponent(requestId)}` : ""}`,
        { ...pageReads(), fetch: operatorRead },
      ),
    readBriefs: (id) =>
      readOperatorRoute(`/projects/${encodeURIComponent(id)}/keeper/briefs`, {
        ...pageReads(),
        fetch: operatorRead,
      }),
    readObjects: (id, query) =>
      readOperatorRoute(
        `/projects/${encodeURIComponent(id)}/keeper/read?${new URLSearchParams(Object.entries(query).map(([key, value]) => [key, String(value)]))}`,
        pageReads(),
      ),
    stream: (id) =>
      fetchTransport(
        `/__agent-forge/projects/${encodeURIComponent(id)}/keeper/events`,
        { fetch: operatorRead },
      ),
    read: (id, query) => {
      const params = new URLSearchParams({
        after: String(query.after),
        limit: "100",
      });
      if (query.requestId) params.set("requestId", query.requestId);
      return readOperatorRoute(
        `/projects/${encodeURIComponent(id)}/keeper?${params}`,
        { ...pageReads(), fetch: operatorRead },
      );
    },
    post: (id, action, body) =>
      actionOutcome(
        () =>
          operatorPost(
            `/__agent-forge/projects/${encodeURIComponent(id)}/keeper/${action}`,
            body,
          ),
        "Check the original request in this conversation before trying again.",
      ),
  });
  const keeper = client.current;
  useEffect(
    () => keeper.subscribe(() => paint((value) => value + 1)),
    [keeper],
  );
  useEffect(() => {
    keeper.activate(projectId);
  }, [keeper, projectId]);
  useEffect(() => () => keeper.dispose(), [keeper]);
  return keeper;
}
