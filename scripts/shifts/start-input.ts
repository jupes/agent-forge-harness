import type { ProjectShiftStartRequest } from "../../types/project-shifts";
import { workspaceKey } from "../projects/scope";

/** Exact version-1 request hash bytes shared with protected browser receipt verification. No runtime authority. */
export function canonicalProjectShiftStart(
  projectId: string,
  workspace: string,
  request: ProjectShiftStartRequest,
): string {
  const options = request.options;
  return JSON.stringify({
    version: 1,
    projectId,
    workspace: workspaceKey(workspace),
    requestId: request.requestId,
    expectedCatalogRevision: request.expectedCatalogRevision,
    options: {
      for: options.for,
      concurrency: options.concurrency,
      maxBeads: options.maxBeads,
      maxUsd: options.maxUsd,
      repairs: options.repairs,
      base: options.base,
      ...(options.epic !== undefined ? { epic: options.epic } : {}),
      ...(options.smith !== undefined ? { smith: options.smith } : {}),
      ...(options.runTimeout !== undefined
        ? { runTimeout: options.runTimeout }
        : {}),
    },
  });
}
