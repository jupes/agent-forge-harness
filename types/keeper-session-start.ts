import type { ConversationReceipt } from "./conversation";
import type { KeeperProposalRecord } from "./keeper-proposal";
import type { OwnedSessionRecord } from "./owned-session";
import type { SessionStartRequest } from "./session-requests";

/** One explicit human Start; the source remains separate from the full reviewed launch. */
export interface KeeperSessionStartRequest {
  sourceHash: string;
  /** The private proposal journal revision, not the Keeper conversation revision. */
  expectedRevision: number;
  start: SessionStartRequest;
}

/** Private durable intent. Neither its existence nor a registry reservation proves dispatch. */
export interface KeeperSessionStartIntent {
  projectId: string;
  proposalId: string;
  workspace: string;
  original: KeeperSessionStartRequest;
  startHash: string;
  reviewHash: string;
  createdAt: string;
}

/** Full original input is returned only by the protected explicit review/recovery endpoint. */
export interface KeeperSessionStartReceipt {
  projectId: string;
  proposalId: string;
  revision: number;
  record: KeeperProposalRecord;
  original: KeeperSessionStartRequest;
  startHash: string;
  /** Derived only from the exact durable ordinary-identity NotSent row; never an admission claim. */
  retryAvailable?: boolean | undefined;
  /** A registry-only reservation is unconfirmed until receipt names the original journal turn. */
  session: OwnedSessionRecord | null;
  receipt: ConversationReceipt | null;
}
