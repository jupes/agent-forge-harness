import { useEffect, useMemo, useState } from "preact/hooks";
import { operatorRead } from "../../../docs/js/operator";
import { createProjectCreateApi } from "./project-create-api";
import {
  createProjectCreateClient,
  type ProjectCreateState,
} from "./project-create-client";

const api = createProjectCreateApi(operatorRead);

export function useProjectCreate(workspace: string | null) {
  const client = useMemo(
    () =>
      createProjectCreateClient({
        workspace,
        options: api.options,
        discovery: api.discovery,
        original: api.original,
        changed: () => undefined,
      }),
    [workspace],
  );
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
