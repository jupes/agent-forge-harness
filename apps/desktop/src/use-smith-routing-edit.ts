import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { operatorPost, operatorRead } from "../../../docs/js/operator";
import { createSmithRoutingEditApi } from "./smith-routing-edit-api";
import type { SmithRoutingEditClientState } from "./smith-routing-edit-client";
import { createSmithRoutingEditClient } from "./smith-routing-edit-client";
import {
  createSmithRoutingEditIdentities,
  SMITH_ROUTING_EDIT_IDENTITIES,
} from "./smith-routing-edit-identities";

const unavailable: SmithRoutingEditClientState = {
  target: "workspace",
  change: null,
  preview: null,
  previewStale: false,
  previewing: false,
  saving: false,
  entries: [],
  notice: "Workspace identity is unavailable; saved routing edits are hidden.",
};

export function useSmithRoutingEdit(
  writesAllowed: boolean,
  trustedWorkspace: string | null,
) {
  const allowed = useRef(writesAllowed);
  allowed.current = writesAllowed;
  const scope =
    trustedWorkspace !== null &&
    trustedWorkspace.length > 0 &&
    trustedWorkspace.length <= 512
      ? trustedWorkspace
      : null;
  const currentScope = useRef(scope);
  currentScope.current = scope;
  const boundApi = useMemo(
    () =>
      createSmithRoutingEditApi({
        post: operatorPost,
        read: operatorRead,
        scope: () => currentScope.current ?? "",
        canWrite: () =>
          allowed.current &&
          currentScope.current !== null &&
          currentScope.current === scope,
      }),
    [scope],
  );
  const client = useMemo(() => {
    if (scope === null) return null;
    let storage: Storage | null = null;
    try {
      storage = window.localStorage;
    } catch {
      /* Reservation fails closed before POST. */
    }
    return createSmithRoutingEditClient({
      identities: (identityScope) =>
        createSmithRoutingEditIdentities({
          scope: identityScope,
          storage,
          withLock: async (work) => {
            if (!navigator.locks)
              throw Error("The shared routing edit lock is unavailable.");
            return navigator.locks.request(
              SMITH_ROUTING_EDIT_IDENTITIES,
              { signal: AbortSignal.timeout(30_000) },
              work,
            );
          },
        }),
      scope: () => currentScope.current ?? "",
      canWrite: () =>
        allowed.current &&
        currentScope.current !== null &&
        currentScope.current === scope,
      requestId: () => crypto.randomUUID(),
      preview: boundApi.preview,
      post: boundApi.edit,
      readOriginal: boundApi.original,
    });
  }, [boundApi, scope]);
  const [snapshot, setSnapshot] = useState<{
    client: typeof client;
    state: SmithRoutingEditClientState;
  }>(() => ({ client, state: client?.get() ?? unavailable }));
  const state =
    snapshot.client === client
      ? snapshot.state
      : (client?.get() ?? unavailable);
  useEffect(() => {
    if (!client) {
      setSnapshot({ client, state: unavailable });
      return;
    }
    const update = () => setSnapshot({ client, state: client.get() });
    const unsubscribe = client.subscribe(update);
    update();
    void client.recover();
    const onStorage = (event: StorageEvent) => {
      if (event.key === SMITH_ROUTING_EDIT_IDENTITIES) void client.recover();
    };
    window.addEventListener("storage", onStorage);
    return () => {
      unsubscribe();
      window.removeEventListener("storage", onStorage);
      client.dispose();
    };
  }, [client]);
  useEffect(() => {
    if (writesAllowed) void client?.recover();
  }, [client, writesAllowed]);
  return { client, state, canWrite: writesAllowed && client !== null };
}
