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
