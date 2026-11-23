export type KeeperReadKind =
  | "beads"
  | "queue"
  | "sessions"
  | "runs"
  | "activity";

export interface KeeperReadQuery {
  kind: KeeperReadKind;
  id?: string;
  after?: number;
  limit?: number;
}

export interface KeeperReadResult {
  scope: {
    projectId: string;
    name: string;
    slug: string;
    catalogRevision: number;
    workspace: string;
    repositories: string[];
    epicIds: string[];
    repositoryCount: number;
    epicCount: number;
    detailsComplete: boolean;
    detailsReason: string | null;
    label: string;
    unavailableWorkspaces: number;
  };
  kind: KeeperReadKind;
  mode: "index" | "detail";
  source: string;
  asOf: string;
  complete: boolean;
  reason: string | null;
  records: { id: string; data: unknown; truncated: boolean }[];
  totalKnown: number | null;
  nextCursor: number | null;
}
