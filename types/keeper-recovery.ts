import type { ConversationBinding } from "./conversation";
import type { Smith } from "./hearth";

/** A provider report is evidence, never a quota-based routing instruction. */
export interface KeeperReadiness {
  connection: "ready" | "signed-out" | "adapter-missing" | "unknown";
  allowance: "available" | "exhausted" | "unreported";
  canStart: boolean;
  source: string;
  asOf: string;
  reason: string;
}

export interface KeeperContinuationRequest {
  requestId: string;
  expectedRevision: number;
  mode: "switch" | "fresh";
  smith: string;
  /** Exact human-reviewed context. No automatic summarization or provider call. */
  summary: string;
}

export interface KeeperContinuationRecord extends KeeperContinuationRequest {
  hash: string;
  revision: number;
  generation: number;
  sourceSequence: number;
  at: string;
  previousBinding: ConversationBinding | null;
  resumed: boolean;
}

/** Keeper-only optional journal extension; generic sessions never populate it. */
export interface KeeperRecoveryState {
  smith: string;
  generation: number;
  continuation: KeeperContinuationRecord;
  /** Never evict idempotency history; further changes refuse when this is full. */
  records: KeeperContinuationRecord[];
}

export interface KeeperRecoveryPage {
  projectId: string;
  conversationRevision: number;
  selectedSmith: string;
  choices: { smith: Smith; readiness: KeeperReadiness }[];
  continuation: KeeperContinuationRecord | null;
  request: KeeperContinuationRecord | null;
}
