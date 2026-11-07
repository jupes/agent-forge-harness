import type { ProjectRecord } from "../../types/projects";
import { ConversationError } from "../conversations/error";

/** CLI authentication/cost accounting cannot currently support the daily API admission contract. */
export function assertProjectCliCostAdmission(project: ProjectRecord): void {
  if (project.archived)
    throw new ConversationError(
      409,
      "This project is archived. Existing Stop and original recovery remain available.",
    );
  if (project.budgets?.dailyApiKeyCapUsd != null)
    throw new ConversationError(
      409,
      "Daily API-key admission protection is enabled for this project. Session, Keeper and Shift modes cannot verify the required authentication and cost accounting, so no new provider work was admitted. Council API reviews support reviewed allocations. Existing work and Stop remain available.",
    );
}

/** Throws on lost project authority; only an actual cost-policy refusal returns false. */
export function projectShiftAttemptBudgetAllowed(
  project: ProjectRecord | undefined,
  snapshot: { spentUsd: number; unpriced: number },
  reviewedMaxUsd: number,
): boolean {
  if (!project)
    throw new ConversationError(
      409,
      "This project is no longer in the catalog. No new private input was admitted.",
    );
  if (project.archived) assertProjectCliCostAdmission(project);
  if (project.budgets?.dailyApiKeyCapUsd != null) return false;
  const cap = project.budgets?.shiftSpendCapUsd;
  return (
    cap == null ||
    (snapshot.unpriced === 0 &&
      snapshot.spentUsd < Math.min(cap, reviewedMaxUsd))
  );
}
