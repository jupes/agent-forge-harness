import type { ProjectShiftStartRequest } from "./project-shifts";

/** Full human-reviewed project Shift request bound to one Keeper proposal source. */
export interface KeeperShiftStartRequest {
  sourceHash: string;
  /** Revision of the private Keeper proposal journal at review time. */
  expectedRevision: number;
  start: ProjectShiftStartRequest;
}

/** The small values Keeper proposed before the operator reviewed full defaults. */
export interface KeeperShiftStartProposal {
  durationMinutes: number;
  concurrency: number;
  beadLimit: number;
  spendLimitUsd: number;
}

/** Private durable original. Its presence does not prove the Shift was dispatched. */
export interface KeeperShiftStartIntent {
  projectId: string;
  proposalId: string;
  workspace: string;
  proposal: KeeperShiftStartProposal;
  original: KeeperShiftStartRequest;
  startHash: string;
  reviewHash: string;
  createdAt: string;
}
