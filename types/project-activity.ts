import type { LedgerEventKind } from "./hearth";

/** Ledger metadata only. No private conversation, request body or control authority. */
export interface ProjectActivityEvent {
  id: number;
  ulid: string;
  at: string;
  kind: LedgerEventKind;
  actor: {
    provider: string;
    model: string;
    effort: string | null;
    smith: string | null;
  } | null;
  beadId: string | null;
  sessionId: string | null;
  runId: string | null;
  summary: string;
  metadata: Array<{ key: string; value: string | number | boolean }>;
}

export interface ProjectActivityFilters {
  kinds: LedgerEventKind[];
  provider: string | null;
  beadId: string | null;
  sessionId: string | null;
  runId: string | null;
  shiftId: string | null;
  since: string | null;
  until: string | null;
}

export interface ProjectActivityPage {
  projectId: string;
  workspace: string;
  asOf: string;
  filters: ProjectActivityFilters;
  after: number;
  nextAfter: number;
  /** Raw ledger continuation, even when all rows in this page were suppressed. */
  more: boolean;
  events: ProjectActivityEvent[];
  membershipComplete: boolean;
  problems: string[];
}

export interface ProjectActivityDetail {
  projectId: string;
  workspace: string;
  asOf: string;
  event: ProjectActivityEvent;
}
