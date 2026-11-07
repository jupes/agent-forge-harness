import { useEffect, useRef, useState } from "preact/hooks";
import { operatorPost, operatorRead } from "../../../docs/js/operator";
import { pageReads, readOperatorRoute } from "../../../docs/js/use-stream";
import { ProjectKnowledgeOwner } from "./project-knowledge-client";

export function useProjectKnowledge() {
  const held = useRef<ProjectKnowledgeOwner | null>(null);
  held.current ??= new ProjectKnowledgeOwner({
    read: (url) =>
      readOperatorRoute<unknown>(url, { ...pageReads(), fetch: operatorRead }),
    post: operatorPost,
    withLock: async (work) => {
      if (!navigator.locks)
        throw Error("Shared knowledge recovery storage is unavailable");
      return navigator.locks.request(
        "agent-forge.project-knowledge.v1",
        { signal: AbortSignal.timeout(10000) },
        work,
      );
    },
    readPending: () => {
      const raw = localStorage.getItem("agent-forge-project-knowledge-v1");
      try {
        return raw === null ? {} : JSON.parse(raw);
      } catch {
        throw Error("Knowledge recovery metadata is malformed");
      }
    },
    writePending: (value) =>
      localStorage.setItem(
        "agent-forge-project-knowledge-v1",
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
  });
  const owner = held.current,
    [state, setState] = useState(owner.snapshot());
  useEffect(() => owner.subscribe(setState), [owner]);
  return { ...state, owner };
}
