import type { ConversationObject, ConversationPhase } from "./conversation";
import type { Smith } from "./hearth";

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
        scopeHash?: string | undefined;
        revision: number;
      };
    };

/** Trusted effective Keeper choice frozen for a reviewed brief attempt. */
export type KeeperBriefSelection = Pick<
  Smith,
  "name" | "provider" | "model" | "effort" | "enabled" | "tags"
> & { enabled: true };

/** Exact private original retained before an explicit brief turn is admitted. */
export interface KeeperBriefIntent {
  version: 1;
  requestId: string;
  projectId: string;
  conversationId: string;
  expectedRevision: number;
  origin: KeeperBriefOriginBinding;
  selection: KeeperBriefSelection;
  purpose: "brief";
  intentHash: string;
  text: string;
  about: ConversationObject[];
  snapshot: KeeperBriefSnapshot;
  createdAt: string;
  state: "reserved" | "admitted" | "retired";
  preparedTurnHash: string;
}

/** Wire request for a server-derived Keeper brief origin; paths and scopes stay private. */
export type KeeperBriefOriginRequest =
  | { kind: "overview" }
  | { kind: "onboarding"; projectCreateRequestId: string };

export interface KeeperBriefIntentReserveRequest {
  expectedRevision: number;
  origin: KeeperBriefOriginRequest;
}

export type KeeperBriefIntentReference = Pick<
  KeeperBriefIntent,
  "requestId" | "expectedRevision" | "intentHash"
>;

/** Intent metadata is safe for the protected review workflow; it contains no original prose. */
export type KeeperBriefIntentMetadata = Pick<
  KeeperBriefIntent,
  | "version"
  | "requestId"
  | "projectId"
  | "conversationId"
  | "expectedRevision"
  | "origin"
  | "selection"
  | "purpose"
  | "intentHash"
  | "createdAt"
  | "state"
  | "preparedTurnHash"
>;

export interface KeeperBriefIntentHistory {
  version: 1;
  active: KeeperBriefIntent | null;
  history: KeeperBriefIntent[];
}
