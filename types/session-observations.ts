import type { CodexChatForkOrigin } from "./codex-chat-fork";
import type { OwnedCodingSessionRecord } from "./codex-owned-task";
import type { SessionSummary } from "./hearth";
import type { ProjectShiftAttemptOrigin } from "./shift-origin";

/** Metadata provenance only. Neither this index nor a PID grants private or process authority. */
export interface SessionOwnershipMetadata {
  record: OwnedCodingSessionRecord;
  origin: ProjectShiftAttemptOrigin | CodexChatForkOrigin | null;
}

export interface ProjectSessionObservations {
  projectId: string;
  workspace: string;
  asOf: string;
  observations: SessionSummary[];
  observationsComplete: boolean;
  ownership:
    | { available: true; records: SessionOwnershipMetadata[]; reason: null }
    | { available: false; records: []; reason: string };
  problems: string[];
}

/** Only facts the metadata ledger actually stores. Hashes are not reconstructed into input. */
export type SessionObservedActivity = {
  id: number;
  at: string;
} & (
  | { kind: "session.started" }
  | { kind: "session.ended"; reason: string | null; durationMs: number | null }
  | { kind: "prompt.submitted"; length: number }
  | {
      kind: "tool.called";
      tool: string;
      durationMs: number | null;
      exitCode: number | null;
    }
);

export interface SessionObservationDetail {
  projectId: string;
  workspace: string;
  asOf: string;
  sessionId: string;
  observation: SessionSummary | null;
  owner: SessionOwnershipMetadata | null;
  ownershipAvailable: boolean;
  ownershipReason: string | null;
  parent: { id: string; available: boolean } | null;
  after: number;
  nextAfter: number;
  more: boolean;
  activity: SessionObservedActivity[];
  problems: string[];
}
