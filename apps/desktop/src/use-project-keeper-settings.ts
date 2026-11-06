import { useEffect, useRef, useState } from "preact/hooks";
import { operatorPost } from "../../../docs/js/operator";
import { pageReads, readOperatorRoute } from "../../../docs/js/use-stream";
import { ProjectKeeperSettingsOwner } from "./project-keeper-settings-client";

const KEY = "agent-forge-pending-keeper-settings-v1";
export function useProjectKeeperSettings(refreshHome: () => Promise<unknown>) {
  const held = useRef<ProjectKeeperSettingsOwner | null>(null);
  held.current ??= new ProjectKeeperSettingsOwner({
    read: () => readOperatorRoute<unknown>("/projects", pageReads()),
    post: (url, body) =>
      operatorPost(url, body, { maxBodyBytes: 2 * 1024 * 1024 }),
    refreshHome,
    readPending: () => {
      const raw: unknown = JSON.parse(sessionStorage.getItem(KEY) ?? "{}");
      if (!raw || typeof raw !== "object" || Array.isArray(raw))
        throw Error("Invalid pending Keeper changes");
      const entries = Object.entries(raw);
      if (
        entries.length > 100 ||
        entries.some(
          ([id, rev]) =>
            !/^project-[0-9a-f-]{36}$/.test(id) ||
            !Number.isSafeInteger(rev) ||
            typeof rev !== "number" ||
            rev < 0,
        )
      )
        throw Error("Invalid pending Keeper changes");
      return Object.fromEntries(entries);
    },
    writePending: (pending) =>
      sessionStorage.setItem(KEY, JSON.stringify(pending)),
  });
  const owner = held.current;
  const [state, setState] = useState(owner.snapshot());
  useEffect(() => owner.subscribe(setState), [owner]);
  return { ...state, owner };
}
