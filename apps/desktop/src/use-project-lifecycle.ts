import { useEffect, useRef, useState } from "preact/hooks";
import { operatorPost } from "../../../docs/js/operator";
import { pageReads, readOperatorRoute } from "../../../docs/js/use-stream";
import { ProjectLifecycleOwner } from "./project-lifecycle-client";

export function useProjectLifecycle(refresh: () => Promise<unknown>) {
  const held = useRef<ProjectLifecycleOwner | null>(null);
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  held.current ??= new ProjectLifecycleOwner({
    read: (url) => readOperatorRoute<unknown>(url, pageReads()),
    post: operatorPost,
    withLock: async (work) => {
      if (!navigator.locks)
        throw Error(
          "Shared deletion recovery storage is unavailable. No deletion was sent.",
        );
      return navigator.locks.request(
        "agent-forge.project-deletions.v1",
        { signal: AbortSignal.timeout(10_000) },
        work,
      );
    },
    readPending: () => {
      const raw = localStorage.getItem("agent-forge-project-deletions-v1");
      return raw === null ? {} : JSON.parse(raw);
    },
    writePending: (value) =>
      localStorage.setItem(
        "agent-forge-project-deletions-v1",
        JSON.stringify(value),
      ),
    uuid: () => crypto.randomUUID(),
    hash: async (text) =>
      [
        ...new Uint8Array(
          await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
        ),
      ]
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join(""),
    refresh: () => refreshRef.current(),
  });
  const owner = held.current,
    [state, setState] = useState(owner.snapshot());
  useEffect(() => owner.subscribe(setState), [owner]);
  return { ...state, owner };
}
