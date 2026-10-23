import type { OwnedCodingSessionRecord } from "./codex-owned-task";
import type { ConversationState, ConversationTurn } from "./conversation";

/** A complete saved revision, with no internal process owner or decision authority. */
export interface SessionTranscriptExport {
  format: "agent-forge.session-transcript";
  version: 1;
  complete: true;
  exportedAt: string;
  session: OwnedCodingSessionRecord;
  lastSequence: number;
  conversation: Omit<
    ConversationState,
    "version" | "projectId" | "turns" | "keeperRecovery"
  > & { turns: Omit<ConversationTurn, "owner">[] };
}

/** Public metadata for a private library preference; never a process control. */
export interface SessionLibraryEntry {
  projectId: string;
  sessionId: string;
  startRequestId: string;
  startRequestHash: string;
  revision: number;
  archived: boolean;
  updatedAt: string | null;
}

export interface SessionArchiveRequest {
  requestId: string;
  expectedRevision: number;
  archived: boolean;
}

export interface SessionArchiveReceipt {
  projectId: string;
  sessionId: string;
  startRequestId: string;
  startRequestHash: string;
  original: SessionArchiveRequest;
  outcome: "applied" | "refused";
  revision: number;
  archived: boolean;
  at: string;
  reason: string | null;
}

export interface SessionLibraryRead {
  entry: SessionLibraryEntry;
  receipt: SessionArchiveReceipt | null;
}

export interface SessionLibraryList {
  projectId: string;
  entries: SessionLibraryEntry[];
}
