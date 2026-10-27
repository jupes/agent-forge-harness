import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { operatorPost, operatorRead } from "../../../docs/js/operator";
import { createProjectCreateApi } from "./project-create-api";
import {
  createProjectCreateIdentities,
  PROJECT_CREATE_IDENTITIES,
} from "./project-create-identities";
import {
  createProjectCreateOwner,
  type ProjectCreateState,
} from "./project-create-owner";

const api = createProjectCreateApi({ read: operatorRead, post: operatorPost });

export function useProjectCreate(
  workspace: string | null,
  writesAllowed: boolean,
) {
  const workspaceRef = useRef(workspace);
  workspaceRef.current = workspace;
  const writes = useMemo(() => ({ current: writesAllowed }), []);
  writes.current = writesAllowed;
  const client = useMemo(() => {
    let storage: Storage | null = null;
    try {
      storage = window.localStorage;
    } catch {
      // Metadata storage failure blocks reservation before any POST.
    }
    return createProjectCreateOwner({
      workspace,
      currentWorkspace: () => workspaceRef.current,
      canWrite: () => writes.current,
      identities: createProjectCreateIdentities({
        workspace: workspace ?? "/",
        storage,
        withLock: async (work) => {
          if (!navigator.locks)
            throw Error("The shared project-create lock is unavailable.");
          return navigator.locks.request(
            PROJECT_CREATE_IDENTITIES,
            { signal: AbortSignal.timeout(30_000) },
            work,
          );
        },
      }),
      api,
      mint: () => crypto.randomUUID(),
      changed: () => undefined,
    });
  }, [workspace]);
  const [snapshot, setSnapshot] = useState<{
    client: typeof client;
    state: ProjectCreateState;
  }>(() => ({ client, state: client.get() }));
  const state = snapshot.client === client ? snapshot.state : client.get();

  useEffect(() => {
    const update = () => setSnapshot({ client, state: client.get() });
    const unsubscribe = client.subscribe(update);
    update();
    void client.recover();
    return () => {
      unsubscribe();
      client.dispose();
    };
  }, [client]);

  return { client, state, refresh: client.recover };
}
