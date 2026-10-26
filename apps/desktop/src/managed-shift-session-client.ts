import { workspaceKey } from "../../../scripts/projects/scope";
import { sessionOwnershipMetadataSchema } from "../../../scripts/projects/session-observations-protocol";
import type { ProjectShiftReceipt } from "../../../types/project-shifts";
import type { ProjectShiftAttemptOrigin } from "../../../types/shift-origin";
import { verifyProjectShiftReceipt } from "./project-shift-receipt";

export interface ManagedShiftTarget {
  projectId: string;
  workspace: string;
  sessionId: string;
  origin: ProjectShiftAttemptOrigin;
}

export function managedShiftTargetKey(
  target: ManagedShiftTarget | null,
): string | null {
  if (!target) return null;
  const { origin } = target;
  return JSON.stringify([
    target.projectId,
    workspaceKey(target.workspace),
    target.sessionId,
    origin.kind,
    origin.projectId,
    origin.originalRequestId,
    origin.shiftId,
    origin.runId,
    origin.beadId,
    origin.attempt,
  ]);
}

/** A checked metadata address selects the dedicated reader; it does not authorize the body. */
export function managedShiftTarget(
  projectId: string,
  workspace: string,
  sessionId: string,
  owner: unknown,
  expectedRequestId?: string,
): ManagedShiftTarget | null {
  const checked = sessionOwnershipMetadataSchema.safeParse(owner);
  if (!checked.success) return null;
  const { record, origin } = checked.data;
  if (
    !origin ||
    origin.kind !== "shift" ||
    record.mode !== "task" ||
    record.id !== sessionId ||
    record.projectId !== projectId ||
    origin.projectId !== projectId ||
    workspaceKey(record.workspace) !== workspaceKey(workspace) ||
    workspaceKey(record.repository) !== workspaceKey(workspace) ||
    (expectedRequestId !== undefined &&
      origin.originalRequestId !== expectedRequestId)
  )
    return null;
  return { projectId, workspace, sessionId, origin };
}

/** Read-only lifecycle: no identity reservation, journal writes, provider or control dependency. */
export function createManagedShiftSessionClient(deps: {
  read(path: string): Promise<unknown>;
  changed(): void;
}) {
  const state: {
    receipt: ProjectShiftReceipt | null;
    loading: boolean;
    error: string;
  } = {
    receipt: null,
    loading: false,
    error: "",
  };
  let epoch = 0,
    closed = false,
    activeKey: string | null = null;
  return {
    get: () => state,
    forTarget: (target: ManagedShiftTarget | null) =>
      !closed && managedShiftTargetKey(target) === activeKey
        ? state
        : { receipt: null, loading: target !== null, error: "" },
    async activate(target: ManagedShiftTarget | null) {
      const owner = ++epoch;
      activeKey = managedShiftTargetKey(target);
      state.receipt = null;
      state.loading = target !== null;
      state.error = "";
      if (closed) return;
      deps.changed();
      if (!target) return;
      try {
        const receipt = await verifyProjectShiftReceipt(
          target,
          await deps.read(
            `/projects/${encodeURIComponent(target.projectId)}/shifts/requests/${encodeURIComponent(target.origin.originalRequestId)}`,
          ),
          {
            requestId: target.origin.originalRequestId,
            shiftId: target.origin.shiftId,
          },
        );
        if (closed || epoch !== owner) return;
        state.receipt = receipt;
      } catch {
        if (closed || epoch !== owner) return;
        state.error =
          "This session's original Shift could not be verified. No private attempt or action was opened. Refresh to check the original again.";
      } finally {
        if (!closed && epoch === owner) {
          state.loading = false;
          deps.changed();
        }
      }
    },
    close() {
      closed = true;
      epoch++;
      activeKey = null;
      state.receipt = null;
      state.loading = false;
    },
  };
}
