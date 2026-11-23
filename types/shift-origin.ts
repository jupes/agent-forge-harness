/** Metadata-only provenance, supplied exclusively by the trusted shift runtime. */
export interface ProjectShiftAttemptOrigin {
  kind: "shift";
  projectId: string;
  originalRequestId: string;
  shiftId: string;
  runId: string;
  beadId: string;
  attempt: number;
}
