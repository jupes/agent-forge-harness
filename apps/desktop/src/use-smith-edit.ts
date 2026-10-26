import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { operatorPost, operatorRead } from "../../../docs/js/operator";
import { createSmithEditApi } from "./smith-edit-api";
import type { SmithEditClientState } from "./smith-edit-client";
import { createSmithConfigEditClient } from "./smith-edit-client";
import {
  createSmithEditIdentities,
  SMITH_EDIT_IDENTITIES,
} from "./smith-edit-identities";

const emptyState: SmithEditClientState = {
  target: "workspace",
  name: "",
  smith: {
    name: "",
    provider: "",
    model: "",
    effort: "",
    enabled: true,
    tags: [],
  },
  preview: null,
  previewStale: false,
  previewing: false,
  saving: false,
  entries: [],
  activeRequestId: null,
  notice: "Workspace identity is unavailable; saved edit receipts are hidden.",
};

function metadataScope(workspace: string | null): string | null {
  return workspace !== null && workspace.length > 0 && workspace.length <= 512
    ? workspace
    : null;
}

/** The owner stays at DesktopApp level; closing Smiths or the dialog cannot discard an edit. */
export function useSmithEdit(
  writesAllowed: boolean,
  trustedWorkspace: string | null,
) {
  const allowed = useRef(writesAllowed);
  allowed.current = writesAllowed;
  const scope = metadataScope(trustedWorkspace);
  const currentScope = useRef(scope);
  currentScope.current = scope;
  const api = useMemo(
    () =>
      createSmithEditApi({
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
      // The reservation refuses before any edit POST when browser storage is unavailable.
    }
    const withLock = async <T>(work: () => T | Promise<T>): Promise<T> => {
      if (!navigator.locks)
        throw Error("The shared Smith edit identity lock is unavailable.");
      return navigator.locks.request(
        SMITH_EDIT_IDENTITIES,
        { signal: AbortSignal.timeout(30_000) },
        work,
      );
    };
    return createSmithConfigEditClient({
      identities: (identityScope) =>
        createSmithEditIdentities({ scope: identityScope, storage, withLock }),
      scope: () => currentScope.current ?? "",
      canWrite: () =>
        allowed.current &&
        currentScope.current !== null &&
        currentScope.current === scope,
      requestId: () => crypto.randomUUID(),
      preview: api.preview,
      post: (request, reservation) => api.edit(request, reservation),
      readOriginal: api.original,
    });
  }, [api, scope]);
  const [snapshot, setSnapshot] = useState<{
    client: typeof client;
    state: SmithEditClientState;
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
      if (event.key === SMITH_EDIT_IDENTITIES) void client.recover();
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
