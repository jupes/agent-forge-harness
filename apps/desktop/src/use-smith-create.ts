import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { operatorPost, operatorRead } from "../../../docs/js/operator";
import { createSmithCreateApi } from "./smith-create-api";
import type { SmithCreateClientState } from "./smith-create-client";
import { createSmithConfigCreateClient } from "./smith-create-client";
import {
  createSmithCreateIdentities,
  SMITH_CREATE_IDENTITIES,
} from "./smith-create-identities";
import {
  smithCreateMetadataScope,
  smithCreateScopeAllowsWrite,
} from "./smith-create-scope";

const api = createSmithCreateApi({ post: operatorPost, read: operatorRead });

/** The request's metadata and GET-only recovery live above Smiths route changes. */
const emptyState: SmithCreateClientState = {
  target: "workspace",
  smith: {
    name: "",
    provider: "",
    model: "",
    effort: "",
    enabled: true,
    tags: [],
  },
  preview: null,
  previewing: false,
  creating: false,
  entries: [],
  activeRequestId: null,
  serverDiscoveryReady: false,
  notice:
    "Workspace identity is unavailable; saved create receipts are hidden.",
};

export function useSmithCreate(
  writesAllowed: boolean,
  trustedWorkspace: string | null,
) {
  const allowed = useRef(writesAllowed);
  allowed.current = writesAllowed;
  const scope = smithCreateMetadataScope(trustedWorkspace);
  const currentScope = useRef(scope);
  currentScope.current = scope;
  const client = useMemo(() => {
    if (scope === null) return null;
    let storage: Storage | null = null;
    try {
      storage = window.localStorage;
    } catch {
      // Identity reservation will refuse before any POST.
    }
    return createSmithConfigCreateClient({
      identities: createSmithCreateIdentities({
        scope,
        storage,
        withLock: async (work) => {
          if (!navigator.locks)
            throw Error(
              "The shared Smith create identity lock is unavailable.",
            );
          return navigator.locks.request(
            SMITH_CREATE_IDENTITIES,
            { signal: AbortSignal.timeout(30_000) },
            work,
          );
        },
      }),
      canWrite: () =>
        smithCreateScopeAllowsWrite(
          allowed.current,
          currentScope.current,
          scope,
        ),
      requestId: () => crypto.randomUUID(),
      preview: api.preview,
      post: api.create,
      reserve: api.reserve,
      list: api.list,
      retireReserved: api.retireReserved,
      readOriginal: api.original,
    });
  }, [scope]);
  const [snapshot, setSnapshot] = useState<{
    client: typeof client;
    state: SmithCreateClientState;
  }>(() => ({ client, state: client?.get() ?? emptyState }));
  const state =
    snapshot.client === client ? snapshot.state : (client?.get() ?? emptyState);
  useEffect(() => {
    if (!client) {
      setSnapshot({ client, state: emptyState });
      return;
    }
    const update = () => setSnapshot({ client, state: client.get() });
    const unsubscribe = client.subscribe(update);
    update();
    void client.recover();
    const onStorage = (event: StorageEvent) => {
      if (event.key === SMITH_CREATE_IDENTITIES) void client.recover();
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
