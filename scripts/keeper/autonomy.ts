import { ConversationError } from "../conversations/error";
import { assertProjectCliCostAdmission } from "../projects/project-budget-policy";
import { createProjectStore } from "../projects/store";

/** Rechecked only for a new human approval; existing originals retain their authority. */
export function assertKeeperProposalAdmission(
  home: string,
  projectId: string,
  providerWork = false,
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
  if (providerWork) assertProjectCliCostAdmission(project);
  else if (project.archived)
    throw new ConversationError(
      409,
      "This project is archived. New proposal approvals are unavailable; original recovery remains readable.",
    );
}
