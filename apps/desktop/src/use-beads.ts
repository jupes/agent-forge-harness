import { useOperatorRead } from "../../../docs/js/use-stream";
import { projectBeadsPageSchema } from "../../../scripts/projects/beads-protocol";
import type { ProjectBeadsPage } from "../../../types/project-beads";

/** Uses the window's existing ledger stream and bounded read coordinator. */
export function useBeads(projectId: string | null) {
  const read = useOperatorRead<ProjectBeadsPage>(
    projectId
      ? `/projects/${encodeURIComponent(projectId)}/beads`
      : "/projects",
    [
      "bead.transitioned",
      "operator.action",
      "session.started",
      "session.ended",
    ],
    projectId !== null,
  );
  const parsed = projectBeadsPageSchema.safeParse(read.data);
  const verified = parsed.success && parsed.data.projectId === projectId;
  return {
    ...read,
    data: verified ? parsed.data : null,
    error:
      read.error ||
      (read.data && !verified
        ? "The live bead read could not be verified. Refresh to check again."
        : null),
  };
}
