import type { ProjectRecord } from "../../types/projects";
import { ConversationError } from "../conversations/error";

/** CLI authentication/cost accounting cannot currently support the daily API admission contract. */
export function assertProjectCliCostAdmission(project: ProjectRecord): void {
  if(project.archived) throw new ConversationError(409, "This project is archived. Existing Stop and original recovery remain available.");
  if(project.budgets?.dailyApiKeyCapUsd != null) throw new ConversationError(409, "Daily API-key admission protection is enabled for this project. Session, Keeper and Shift modes cannot verify the required authentication and cost accounting, so no new provider work was admitted. Council API reviews support reviewed allocations. Existing work and Stop remain available.");
}
