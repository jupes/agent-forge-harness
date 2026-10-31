import { useEffect, useRef, useState } from "preact/hooks";
import { operatorPost } from "../../../docs/js/operator";
import { pageReads, readOperatorRoute } from "../../../docs/js/use-stream";
import {
  ProjectGeneralSettingsOwner,
  type GeneralSettingsSnapshot,
} from "./project-general-settings-client";

export function useProjectGeneralSettings(refreshProjectHome: () => Promise<unknown>) {
  const ownerRef = useRef<ProjectGeneralSettingsOwner | null>(null);
  ownerRef.current ??= new ProjectGeneralSettingsOwner({
    read: () => readOperatorRoute<unknown>("/projects", pageReads()),
    post: operatorPost,
    refreshHome: refreshProjectHome,
  });
  const owner = ownerRef.current;
  const [snapshot, setSnapshot] = useState<GeneralSettingsSnapshot>(
    owner.snapshot(),
  );
  useEffect(() => owner.subscribe(setSnapshot), [owner]);
  return { ...snapshot, owner };
}
