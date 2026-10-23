import type { OwnedCodingSessionRecord } from "./codex-owned-task";

/** An index observation is metadata only; selecting an attempt verifies its private journal separately. */
export interface ProjectShiftAttemptsPage {
  projectId: string;
  originalRequestId: string;
  shiftId: string;
  asOf: string;
  items: Array<{
    session: OwnedCodingSessionRecord;
    phase: "unknown";
    reason: string;
    controllable: false;
  }>;
}
