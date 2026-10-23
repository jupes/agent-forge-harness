import { projectShiftStartOptionsSchema } from "../../../scripts/shifts/protocol";
import type {
  ProjectShiftOptions,
  ProjectShiftStartRequest,
} from "../../../types/project-shifts";

export interface ProjectShiftDraft {
  expectedCatalogRevision: number;
  for: string;
  concurrency: string;
  maxBeads: string;
  maxUsd: string;
  repairs: string;
  base: string;
  epic: string;
  smith: string;
  runTimeout: string;
}
export function newProjectShiftDraft(
  options: ProjectShiftOptions,
): ProjectShiftDraft {
  return {
    expectedCatalogRevision: options.catalogRevision,
    for: options.defaults.for.value,
    concurrency: String(options.defaults.concurrency.value),
    maxBeads: String(options.defaults.maxBeads.value),
    maxUsd: String(options.defaults.maxUsd.value),
    repairs: String(options.defaults.repairs.value),
    base: options.defaults.base.value,
    epic: "",
    smith: "",
    runTimeout: "",
  };
}
export function reviewedProjectShift(
  options: ProjectShiftOptions,
  draft: ProjectShiftDraft,
):
  | { ok: true; input: Omit<ProjectShiftStartRequest, "requestId"> }
  | { ok: false; reason: string } {
  if (draft.expectedCatalogRevision !== options.catalogRevision)
    return {
      ok: false,
      reason:
        "The project choices changed. Use the current defaults and review the shift again.",
    };
  if (
    [draft.concurrency, draft.maxBeads, draft.maxUsd, draft.repairs].some(
      (value) => !value.trim(),
    )
  )
    return { ok: false, reason: "Enter every numeric bound before Start." };
  const checked = projectShiftStartOptionsSchema.safeParse({
    for: draft.for,
    concurrency: Number(draft.concurrency),
    maxBeads: Number(draft.maxBeads),
    maxUsd: Number(draft.maxUsd),
    repairs: Number(draft.repairs),
    base: draft.base,
    ...(draft.epic ? { epic: draft.epic } : {}),
    ...(draft.smith ? { smith: draft.smith } : {}),
    ...(draft.runTimeout ? { runTimeout: draft.runTimeout } : {}),
  });
  if (!checked.success)
    return {
      ok: false,
      reason:
        "Enter valid bounds: a duration within the listed limits, the listed numeric limits, and a branch on origin.",
    };
  if (
    (checked.data.epic !== undefined &&
      !options.epics.some((row) => row.id === checked.data.epic)) ||
    (checked.data.smith !== undefined &&
      !options.smiths.names.includes(checked.data.smith))
  )
    return {
      ok: false,
      reason:
        "Select an epic and enabled smith from the current project choices.",
    };
  return {
    ok: true,
    input: {
      expectedCatalogRevision: draft.expectedCatalogRevision,
      options: checked.data,
    },
  };
}
