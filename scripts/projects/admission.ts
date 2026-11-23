import { ensurePrivateHome } from "../hearth/home-guard";
import { withQueueLock } from "../scheduler/queue-lock";
import {
  createProjectStore,
  isProjectId,
  ProjectStoreError,
  projectWriteLockPath,
} from "./store";

/** Domain lease → project lock → durable reservation publication. Never hold this through execution. */
export async function withProjectAdmission<T>(
  home: string,
  projectId: string,
  publish: () => Promise<T> | T,
): Promise<T> {
  if (!isProjectId(projectId))
    throw new ProjectStoreError(400, "Expected a project id.");
  ensurePrivateHome(home);
  const result = await withQueueLock(
    projectWriteLockPath(home),
    async () => {
      const project = createProjectStore(home)
        .read()
        .projects.find((row) => row.id === projectId);
      if (!project)
        throw new ProjectStoreError(
          404,
          "This project has been removed. Original recovery remains separate from new work.",
        );
      if (project.archived)
        throw new ProjectStoreError(
          409,
          "This project is archived. Unarchive it before new work; existing execution and Stop remain available.",
        );
      return await publish();
    },
    { waitMs: 1000 },
  );
  if (!result.ok)
    throw new ProjectStoreError(
      503,
      "Project admission is busy. No new work was admitted.",
    );
  return result.value;
}
