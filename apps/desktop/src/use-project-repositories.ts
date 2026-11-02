import { useEffect, useRef, useState } from "preact/hooks";
import { pageReads, readOperatorRoute } from "../../../docs/js/use-stream";
import type { ProjectsHome } from "../../../types/project-summary";
import {
  ProjectRepositoriesOwner,
  type ProjectRepositoriesSnapshot,
  projectRepositoriesForSelection,
  projectRepositoriesKey,
} from "./project-repositories-client";

export function useProjectRepositories(
  projectId: string | null,
  revision: number | null,
  refreshProjectHome: () => Promise<ProjectsHome>,
) {
  const ownerRef = useRef<ProjectRepositoriesOwner | null>(null);
  ownerRef.current ??= new ProjectRepositoriesOwner({
    read: (id) =>
      readOperatorRoute<unknown>(
        "/projects/" + encodeURIComponent(id) + "/settings/repositories",
        pageReads(),
      ),
  });
  const owner = ownerRef.current;
  const [snapshot, setSnapshot] = useState<ProjectRepositoriesSnapshot>(
    owner.snapshot(),
  );
  const key = projectRepositoriesKey(projectId, revision);
  const currentKey = useRef(key);
  currentKey.current = key;
  const active = useRef(false);
  const selection = useRef({ projectId, revision });
  selection.current = { projectId, revision };
  const getCurrentSelection = () =>
    active.current ? selection.current : { projectId: null, revision: null };

  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      owner.deactivate();
    };
  }, [owner]);

  useEffect(() => owner.subscribe(setSnapshot), [owner]);
  useEffect(
    () => owner.activate(projectId, revision, getCurrentSelection),
    [owner, projectId, revision],
  );

  const current = projectRepositoriesForSelection(
    snapshot,
    projectId,
    revision,
  );
  const isCurrent = () => active.current && currentKey.current === key;
  return {
    ...current,
    refresh: () => owner.refresh(projectId, revision, isCurrent),
    reconcile: () => owner.reconcile(refreshProjectHome, isCurrent),
  };
}
