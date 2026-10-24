import { useEffect, useRef, useState } from "preact/hooks";
import { operatorPost, operatorRead } from "../../../docs/js/operator";
import {
  appStream,
  pageReads,
  readOperatorRoute,
} from "../../../docs/js/use-stream";
import { createProjectShiftsClient } from "./project-shift-client";
import {
  createProjectShiftIdentities,
  PROJECT_SHIFT_IDENTITIES,
} from "./project-shift-identities";

/** One app-root action owner; project navigation replaces observers, never the original request. */
export function useProjectShifts(
  projectId: string | null,
  workspace: string | null,
  writesAllowed: boolean,
) {
  const writes = useRef(writesAllowed);
  writes.current = writesAllowed;
  const [, paint] = useState(0),
    held = useRef<ReturnType<typeof createProjectShiftsClient> | null>(null);
  if (!held.current) {
    let storage: Storage | null = null;
    try {
      storage = window.localStorage;
    } catch {
      /* A Start cannot leave before its identity is saved. */
    }
    held.current = createProjectShiftsClient({
      canWrite: () => writes.current,
      mint: () => crypto.randomUUID(),
      changed: () => paint((value) => value + 1),
      identities: createProjectShiftIdentities({
        storage,
        withLock: async (work) => {
          if (!navigator.locks)
            throw Error(
              "Cross-window original shift ownership is unavailable.",
            );
          return navigator.locks.request(
            PROJECT_SHIFT_IDENTITIES,
            { signal: AbortSignal.timeout(30_000) },
            work,
          );
        },
      }),
      read: (path) =>
        readOperatorRoute(path, { ...pageReads(), fetch: operatorRead }),
      post: operatorPost,
    });
  }
  const client = held.current;
  useEffect(() => {
    if (!projectId || !workspace) return;
    const scope = { projectId, workspace };
    const refresh = () => {
      if (document.visibilityState === "visible") void client.refresh(scope);
    };
    const stored = (event: StorageEvent) => {
      if (event.key === PROJECT_SHIFT_IDENTITIES) refresh();
    };
    const close = appStream().watch(
      [
        "operator.action",
        "shift.started",
        "shift.stopped",
        "session.started",
        "session.ended",
        "reservation.released",
      ],
      refresh,
    );
    const timer = window.setInterval(refresh, 5000);
    window.addEventListener("storage", stored);
    document.addEventListener("visibilitychange", refresh);
    refresh();
    return () => {
      close();
      window.clearInterval(timer);
      window.removeEventListener("storage", stored);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [client, projectId, workspace]);
  return {
    client,
    scope: projectId && workspace ? { projectId, workspace } : null,
  };
}
