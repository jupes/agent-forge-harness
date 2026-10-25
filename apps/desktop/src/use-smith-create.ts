import { useEffect, useRef, useState } from "preact/hooks";
import { operatorPost, operatorRead } from "../../../docs/js/operator";
import { createSmithCreateApi } from "./smith-create-api";
import { createSmithConfigCreateClient } from "./smith-create-client";
import {
  createSmithCreateIdentities,
  SMITH_CREATE_IDENTITIES,
} from "./smith-create-identities";

const api = createSmithCreateApi({ post: operatorPost, read: operatorRead });

/** The request's metadata and GET-only recovery live above Smiths route changes. */
export function useSmithCreate(writesAllowed: boolean) {
  const allowed = useRef(writesAllowed);
  allowed.current = writesAllowed;
  const held = useRef<ReturnType<typeof createSmithConfigCreateClient> | null>(
    null,
  );
  if (!held.current) {
    let storage: Storage | null = null;
    try {
      storage = window.localStorage;
    } catch {
      // Identity reservation will refuse before any POST.
    }
    held.current = createSmithConfigCreateClient({
      identities: createSmithCreateIdentities({
        scope: `${window.location.origin}${window.location.pathname}`,
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
      canWrite: () => allowed.current,
      requestId: () => crypto.randomUUID(),
      preview: api.preview,
      post: api.create,
      readOriginal: api.original,
    });
  }
  const client = held.current;
  const [state, setState] = useState(() => client.get());
  useEffect(() => {
    const unsubscribe = client.subscribe(() => setState(client.get()));
    setState(client.get());
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
    if (writesAllowed) void client.recover();
  }, [client, writesAllowed]);
  return { client, state, canWrite: writesAllowed };
}
