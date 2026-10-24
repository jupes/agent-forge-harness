import { workspaceKey } from "../../../scripts/projects/scope";
import { projectShiftReceiptSchema } from "../../../scripts/shifts/protocol";
import type { ProjectShiftReceipt } from "../../../types/project-shifts";
import {
  type ProjectShiftScope,
  projectShiftInputHash,
} from "./project-shift-identities";

/** Shared strict response verification. A receipt is an observation, never dispatch authority. */
export async function verifyProjectShiftReceipt(
  scope: ProjectShiftScope,
  raw: unknown,
  expected?: { requestId: string; requestHash?: string; shiftId?: string },
): Promise<ProjectShiftReceipt> {
  const checked = projectShiftReceiptSchema.safeParse(raw);
  if (
    !checked.success ||
    checked.data.intent.projectId !== scope.projectId ||
    workspaceKey(checked.data.intent.workspace) !==
      workspaceKey(scope.workspace)
  )
    throw Error("Foreign or invalid original");
  const receipt = checked.data;
  if (
    receipt.intent.requestHash !==
      (await projectShiftInputHash(scope, receipt.intent.request)) ||
    (expected &&
      (receipt.intent.request.requestId !== expected.requestId ||
        (expected.requestHash !== undefined &&
          receipt.intent.requestHash !== expected.requestHash) ||
        (expected.shiftId !== undefined &&
          receipt.intent.shiftId !== expected.shiftId)))
  )
    throw Error("Changed original input");
  return receipt;
}
