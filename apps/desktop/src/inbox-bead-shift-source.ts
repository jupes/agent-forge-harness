import type { OperatorMove } from "../../../scripts/scheduler/queue-table";
import type { ProjectBeadsPage } from "../../../types/project-beads";
import type { ProjectShiftsPage } from "../../../types/project-shifts";
import type { ProjectWorkbenchPage } from "../../../types/project-workbench";
import type { InboxDispositionScope } from "./inbox-dispositions-client";

export interface InboxSourceRead<T> {
  raw: unknown;
  lastVerified: T | null;
  coverage: {
    started: boolean;
    settled: boolean;
    complete: boolean;
    fresh: boolean;
    error: string | null;
  };
}

export interface InboxBeadShiftProjectionInput {
  scope: InboxDispositionScope;
  sourceGeneration: number;
  catalogRevision: number;
  workbench: InboxSourceRead<ProjectWorkbenchPage>;
  beads: InboxSourceRead<ProjectBeadsPage>;
  shifts: InboxSourceRead<ProjectShiftsPage>;
}

export interface InboxSourceFactBase {
  projectId: string;
  workspace: string;
  stableItemId: string;
  sourceRevision: string;
  title: string;
  detail: string;
  fresh: boolean;
  complete: boolean;
  resolved: false;
  unresolvedReason: string;
}

export type InboxBeadShiftFact =
  | (InboxSourceFactBase & {
      sourceKind: "bead-approval";
      sourceIdentity: {
        beadId: string;
        updatedAt: string;
        queueState: "proposed";
        beadStatus: string;
        backed: true;
        allowedMoves: readonly OperatorMove[];
      };
      status: "pending";
    })
  | (InboxSourceFactBase & {
      sourceKind: "halted-bead";
      sourceIdentity: {
        beadId: string;
        updatedAt: string;
        queueState: "halted";
        beadStatus: string;
        backed: true;
        allowedMoves: readonly OperatorMove[];
      };
      status: "pending";
    })
  | (InboxSourceFactBase & {
      sourceKind: "stopped-shift";
      sourceIdentity: {
        shiftId: string;
        requestId: string;
        recomputedRequestHash: string;
        phase: "needs-recovery";
        reason: string | null;
      };
      status: "pending";
    })
  | (InboxSourceFactBase & {
      sourceKind: "stopped-shift";
      sourceIdentity: {
        shiftId: string;
        requestId: string;
        recomputedRequestHash: string;
        phase: "stopped";
        reason: string | null;
      };
      status: "informational";
    });

export interface InboxBeadShiftProjection {
  scope: InboxDispositionScope;
  sourceGeneration: number;
  catalogRevision: number;
  facts: readonly InboxBeadShiftFact[];
  coverage: Readonly<
    Record<
      "workbench" | "beads" | "shifts",
      InboxSourceRead<unknown>["coverage"]
    >
  >;
  diagnostics: readonly string[];
}

export async function projectInboxBeadShiftSources(
  input: InboxBeadShiftProjectionInput,
): Promise<InboxBeadShiftProjection> {
  return {
    scope: { ...input.scope },
    sourceGeneration: input.sourceGeneration,
    catalogRevision: input.catalogRevision,
    facts: [],
    coverage: {
      workbench: {
        ...input.workbench.coverage,
        complete: false,
        fresh: false,
        error: "Source projection is not available.",
      },
      beads: {
        ...input.beads.coverage,
        complete: false,
        fresh: false,
        error: "Source projection is not available.",
      },
      shifts: {
        ...input.shifts.coverage,
        complete: false,
        fresh: false,
        error: "Source projection is not available.",
      },
    },
    diagnostics: ["Source projection is not available."],
  };
}
