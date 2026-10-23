export type KeeperProposalAction =
  | { kind: "approve-beads"; beadIds: string[] }
  | {
      kind: "start-session";
      provider: "claude" | "codex" | "gemini" | "grok";
      smith: string;
      beadId: string;
      repository: string;
      worktree: "current" | "new";
      prompt: string;
    }
  | {
      kind: "start-shift";
      durationMinutes: number;
      concurrency: number;
      beadLimit: number;
      spendLimitUsd: number;
    }
  | {
      kind: "send-to-council";
      beadId: string;
      profile: string;
      question: string;
    }
  | {
      kind: "create-beads";
      beads: {
        title: string;
        type: "task" | "feature" | "bug" | "chore" | "epic";
        priority: 0 | 1 | 2 | 3 | 4;
        parentId: string;
        description: string;
      }[];
    }
  | {
      kind: "manage-bead";
      beadId: string;
      operation:
        | { kind: "pause" }
        | { kind: "resume" }
        | { kind: "reassign"; smith: string };
    }
  | { kind: "record-decision"; beadId: string; decision: string };

/** Inert requested values. The actual destination checks scope and supported capabilities. */
export interface KeeperProposalDraft {
  title: string;
  detail: string;
  action: KeeperProposalAction;
}
export interface KeeperProposalMessage {
  kind: "keeper.proposals.v1";
  message: string;
  proposals: KeeperProposalDraft[];
}
export interface KeeperProposal {
  id: string;
  projectId: string;
  sourceRequestId: string;
  sourceHash: string;
  createdAt: string;
  draft: KeeperProposalDraft;
}

export interface KeeperProposalRecord extends KeeperProposal {
  requestId: string;
  requestHash: string;
  operation: "approve" | "dismiss";
  auditEventId: number;
  phase: "approved" | "done" | "failed" | "unknown" | "dismissed";
  pending: boolean;
  updatedAt: string;
  message: string;
  objects: import("./conversation").ConversationObject[];
}
export interface KeeperProposalJournal {
  version: 1;
  projectId: string;
  revision: number;
  records: KeeperProposalRecord[];
}
export interface KeeperProposalReceipt {
  projectId: string;
  revision: number;
  record: KeeperProposalRecord;
}
export interface KeeperProposalExecution {
  phase: "approved" | "done" | "failed" | "unknown";
  message: string;
  objects: import("./conversation").ConversationObject[];
}
