import { useEffect, useRef, useState } from "preact/hooks";
import { actionOutcome } from "../../../docs/js/action-outcome";
import { operatorPost, operatorRead } from "../../../docs/js/operator";
import {
  appStream,
  pageReads,
  readOperatorRoute,
} from "../../../docs/js/use-stream";
import type { KeeperClient } from "./keeper-client";
import { createKeeperProposalsClient } from "./keeper-proposals-client";

export function useKeeperProposals(
  projectId: string | null,
  writesAllowed: boolean,
  keeper: KeeperClient,
) {
  const writes = useRef(writesAllowed);
  writes.current = writesAllowed;
  const [, paint] = useState(0);
  const held = useRef<ReturnType<typeof createKeeperProposalsClient> | null>(
    null,
  );
  held.current ??= createKeeperProposalsClient({
    canWrite: () => writes.current,
    requestId: () => crypto.randomUUID(),
    read: (id, query) =>
      readOperatorRoute(
        `/projects/${encodeURIComponent(id)}/keeper/proposals?${new URLSearchParams(query)}`,
        { ...pageReads(), fetch: operatorRead },
      ),
    post: (id, operation, body) =>
      actionOutcome(
        () =>
          operatorPost(
            `/__agent-forge/projects/${encodeURIComponent(id)}/keeper/proposals/${operation}`,
            body,
          ),
        "Check the original Keeper review request before trying again.",
      ),
  });
  const client = held.current;
  useEffect(
    () => client.subscribe(() => paint((value) => value + 1)),
    [client],
  );
  useEffect(() => {
    if (!projectId) return;
    void client.refresh(projectId, true);
    let last = "";
    const update = () => {
      const page = keeper.get(projectId).page;
      const key =
        page?.turns
          .map((turn) => `${turn.requestId}:${turn.phase}`)
          .join(",") ?? "";
      if (key === last) return;
      last = key;
      void client.refresh(projectId, true);
    };
    const stopKeeper = keeper.subscribe(update);
    const stopLedger = appStream().watch(
      ["operator.action", "bead.transitioned"],
      () => {
        void client.refresh(projectId, true);
      },
    );
    return () => {
      stopKeeper();
      stopLedger();
    };
  }, [projectId, client, keeper]);
  useEffect(() => () => client.dispose(), [client]);
  return client;
}
