/** Explicit composer action, separate from Preview and Start. */
export interface SessionWorktreeRequest {
  requestId: string;
  repository: string;
  baseRef: string;
  branch: string;
  beadId?: string | undefined;
}

export interface SessionWorktreeReceipt {
  projectId: string;
  requestId: string;
  repository: string;
  baseRef: string;
  resolvedCommit: string;
  branch: string;
  /** Unknown may expose the planned path for inspection; only created confirms it. */
  worktree: {
    id: string;
    path: string;
    branch: string;
    createdAt: string;
  } | null;
  state: "created" | "unknown" | "refused";
  reason: string | null;
}
