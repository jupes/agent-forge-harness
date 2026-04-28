/**
 * Shared TypeScript types for the Beads issue tracking system.
 * These types mirror the dashboard payload from scripts/build-pages.ts
 * (JSONL and/or normalized `bd export` records).
 */

export type IssueType = "epic" | "feature" | "task" | "bug" | "chore";

export type IssueStatus = "open" | "in_progress" | "closed" | "blocked";

export type IssuePriority = "critical" | "high" | "medium" | "low";

export interface BeadsIssue {
  /** Unique issue identifier, e.g. "EPIC-1", "T-42" */
  id: string;
  /** Issue type */
  type: IssueType;
  /** Short title */
  title: string;
  /** Full description / acceptance criteria */
  description?: string;
  /** Current status */
  status: IssueStatus;
  /** Priority level */
  priority?: IssuePriority;
  /** Parent issue ID (for tasks/features within epics) */
  parent?: string;
  /** Which repo this issue belongs to */
  repo?: string;
  /** ISO 8601 due date */
  due?: string;
  /** ISO 8601 creation timestamp */
  createdAt: string;
  /** ISO 8601 last updated timestamp */
  updatedAt: string;
  /** Agent or user who claimed this issue (explicit assignment — not Beads `owner`) */
  assignee?: string;
  /** Beads/Dolt `owner` field (often creator); does not imply claimed for work */
  owner?: string;
  /** Freeform tags */
  labels?: string[];
  /** Acceptance criteria list */
  ac?: string[];
  /** Estimated effort in minutes */
  estimate?: number;
  /** Actual time spent in minutes */
  spent?: number;
  /** Commit or PR reference that closed this issue */
  closedBy?: string;
}

export interface BeadsDependency {
  /** Issue that is blocked */
  from: string;
  /** Issue that must complete first */
  to: string;
  /** Dependency type */
  type: "blocks" | "requires" | "relates";
}

export interface BeadsComment {
  /** Issue this comment belongs to */
  issueId: string;
  /** Comment body — prefixed with worklog:, ac:, design:, deps:, review: */
  body: string;
  /** Author identifier */
  author: string;
  /** ISO 8601 timestamp */
  createdAt: string;
}

export interface EpicFlowNode {
  /** Child issue ID within an epic initiative. */
  issueId: string;
  /** Human-readable issue title. */
  title: string;
  /** Current status for quick scan in the flow view. */
  status: IssueStatus;
  /** Child issue type. */
  type: IssueType;
  /** Condensed "what changed" summary derived from latest comments/description. */
  summary: string;
  /** Open blocker IDs (incoming blockers) for this child. */
  blockers: string[];
}

export interface EpicFlowEdge {
  /** Downstream issue in the flow relation. */
  from: string;
  /** Upstream issue it depends on / is blocked by. */
  to: string;
  /** Relation type from Beads dependency graph. */
  relation: "blocks" | "requires" | "relates";
}

export interface EpicFlowData {
  /** Selected epic ID. */
  epicId: string;
  /** Selected epic title (if known). */
  epicTitle: string;
  /** Child issues represented as flow nodes. */
  nodes: EpicFlowNode[];
  /** Dependency connections among children and the epic root. */
  edges: EpicFlowEdge[];
}

export interface DerivedData {
  /** Issues grouped by status */
  byStatus: Record<IssueStatus, BeadsIssue[]>;
  /** Issues grouped by type */
  byType: Record<IssueType, BeadsIssue[]>;
  /** Issues grouped by repo */
  byRepo: Record<string, BeadsIssue[]>;
  /** Issues that are unblocked and unclaimed (ready to work) */
  ready: BeadsIssue[];
  /** Issues that are blocked by dependencies */
  blocked: BeadsIssue[];
  /** Dependency edges */
  deps: BeadsDependency[];
  /** Pre-computed epic flow views keyed by epic issue ID. */
  epicFlowByEpic?: Record<string, EpicFlowData>;
}

export interface BeadsPayload {
  /** Schema version */
  version: string;
  /** ISO 8601 timestamp when this payload was generated */
  generatedAt: string;
  /** All issues */
  issues: BeadsIssue[];
  /** All comments */
  comments: BeadsComment[];
  /** All dependency edges */
  deps: BeadsDependency[];
  /** Pre-computed derived views */
  derived: DerivedData;
}

/** Worktree record created by scripts/worktree.ts */
export interface WorktreeRecord {
  /** Short hex ID */
  id: string;
  /** Absolute path to the worktree directory */
  path: string;
  /** Git branch name */
  branch: string;
  /** ISO 8601 creation timestamp */
  createdAt: string;
}

/** Output shape for scripts/worktree.ts commands */
export interface WorktreeResult {
  ok: boolean;
  worktree?: WorktreeRecord;
  worktrees?: WorktreeRecord[];
  error?: string;
}
