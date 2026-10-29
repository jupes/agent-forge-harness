import type { ConversationObject, ConversationPhase } from "./conversation";

export type KeeperBriefSection = "moving" | "waiting" | "stuck";
export interface KeeperBriefSnapshot {
  version: 1;
  projectId: string;
  projectName: string;
  workspace: string;
  catalogRevision: number;
  asOf: string;
  since: string;
  scope: {
    label: string;
    epicIds: string[];
    epicCount: number;
    repositoryCount: number;
  };
  observed: {
    beads: number | null;
    queue: number | null;
    sessions: number | null;
    runs: number | null;
    activity: number | null;
  };
  complete: boolean;
  limitations: string[];
  facts: {
    section: KeeperBriefSection | "context";
    object: ConversationObject;
    title: string;
    state: string;
    at: string | null;
  }[];
}
export interface KeeperBriefContent {
  summary: string;
  moving: { text: string; facts: number[] }[];
  waiting: { text: string; facts: number[] }[];
  stuck: { text: string; facts: number[] }[];
}
export interface KeeperBrief {
  requestId: string;
  createdAt: string;
  snapshot: KeeperBriefSnapshot;
  content: KeeperBriefContent;
}
export interface KeeperBriefs {
  projectId: string;
  revision: number;
  latest: KeeperBrief | null;
  earlier: KeeperBrief[];
  refresh: {
    requestId: string;
    phase: ConversationPhase;
    problem: string | null;
  } | null;
}

/** Trusted source binding frozen into a private Keeper brief review original. */
export type KeeperBriefOriginBinding =
  | {
      kind: "overview";
      projectId: string;
      workspace: string;
      catalogRevision: number;
    }
  | {
      kind: "onboarding";
      projectId: string;
      workspace: string;
      catalogRevision: number;
      projectCreate: {
        requestId: string;
        hash: string;
        revision: number;
      };
    };

/** Exact private original retained before an explicit brief turn is admitted. */
export interface KeeperBriefIntent {
  version: 1;
  requestId: string;
  projectId: string;
  conversationId: string;
  expectedRevision: number;
  origin: KeeperBriefOriginBinding;
  purpose: "brief";
  intentHash: string;
  snapshot: KeeperBriefSnapshot;
  createdAt: string;
  state: "reserved" | "admitted" | "retired";
  preparedTurnHash?: string;
}
