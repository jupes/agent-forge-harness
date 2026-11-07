import { ConversationError } from "../conversations/error";
import { createProjectStore } from "../projects/store";

/** Rechecked only for a new human approval; existing originals retain their authority. */
export function assertKeeperProposalAdmission(
  home: string,
  projectId: string,
): void {
  const project = createProjectStore(home)
    .read()
    .projects.find((item) => item.id === projectId);
  if (!project)
    throw new ConversationError(
      404,
      "This project is not in the hearth catalog.",
    );
  if (project.keeperAutonomy === "suggest-only")
    throw new ConversationError(
      409,
      "Keeper autonomy is Suggest only. New proposal approvals and Starts are disabled; saved originals remain readable.",
    );
}
