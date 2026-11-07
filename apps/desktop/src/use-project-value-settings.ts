import { useEffect, useRef, useState } from "preact/hooks";
import { operatorPost } from "../../../docs/js/operator";
import { pageReads, readOperatorRoute } from "../../../docs/js/use-stream";
import {
  ProjectValueSettingsOwner,
  type ProjectValueSpec,
} from "./project-value-settings-client";

export function useProjectValueSettings<T>(
  spec: ProjectValueSpec<T>,
  refreshHome: () => Promise<unknown>,
) {
  const held = useRef<ProjectValueSettingsOwner<T> | null>(null);
  const key = `agent-forge-pending-project-${spec.key}-v1`;
  held.current ??= new ProjectValueSettingsOwner(spec, {
    read: () => readOperatorRoute<unknown>("/projects", pageReads()),
    post: (url, body) =>
      operatorPost(url, body, { maxBodyBytes: 2 * 1024 * 1024 }),
    refreshHome,
    readPending: () => {
      const raw: unknown = JSON.parse(sessionStorage.getItem(key) ?? "{}");
      if (!raw || typeof raw !== "object" || Array.isArray(raw))
        throw Error("Invalid pending settings metadata");
      const entries = Object.entries(raw);
      if (
        entries.length > 100 ||
        entries.some(
          ([id, revision]) =>
            !/^project-[0-9a-f-]{36}$/.test(id) ||
            typeof revision !== "number" ||
            !Number.isSafeInteger(revision) ||
            revision < 0,
        )
      )
        throw Error("Invalid pending settings metadata");
      return Object.fromEntries(entries);
    },
    writePending: (value) => sessionStorage.setItem(key, JSON.stringify(value)),
  });
  const owner = held.current,
    [state, setState] = useState(owner.snapshot());
  useEffect(() => owner.subscribe(setState), [owner]);
  return { ...state, owner };
}
