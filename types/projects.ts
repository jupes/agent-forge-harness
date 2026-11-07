/** Hearth-level project contract. Records contain metadata, never provider credentials. */
export const PROJECT_COLOR_IDS = ["default", "green", "blue"] as const;
export type ProjectColor = (typeof PROJECT_COLOR_IDS)[number];
export type KeeperAutonomy = "suggest-only" | "propose-for-approval";
export interface ProjectNotificationPreferences {
  "stopped-shift": boolean;
  "failed-gate": boolean;
  "council-verdict": boolean;
  "bead-approval": boolean;
}

export interface ProjectWorkspace {
  /** Canonical ledger workspace, not a linked worktree. */
  root: string;
  /** Canonical local checkouts; descriptive membership, never permission to read another checkout. */
  repositories: string[];
  /** Selected epic ids in this workspace's tracker. */
  epicIds: string[];
}

export interface ProjectRecord {
  /** Generated once, independent of the name/slug. */
  id: string;
  /** Immutable unique slug; the exact membership label is `project:<slug>`. */
  slug: string;
  name: string;
  description: string;
  icon: string;
  workspaces: ProjectWorkspace[];
  /** Default for future unsaved Keeper work; absent means inherit configuration. */
  keeperSmith?: string;
  /** Applies to new Keeper proposal approvals; absence keeps the legacy approval mode. */
  keeperAutonomy?: KeeperAutonomy;
  /** Prefill for fresh ordinary Claude session drafts; absent inherits configuration. */
  claudeSessionSmith?: string;
  codexSessionSmith?: string;
  geminiSessionSmith?: string;
  sessionWhere?: "main" | "existing" | "new";
  sessionRunAs?: "chat" | "task";
  /** OS interruption preferences only; never suppresses Activity or approval authority. */
  notifications?: ProjectNotificationPreferences;
  /** Local admission limits, never an account balance or guaranteed billed total. */
  budgets?: {
    shiftSpendCapUsd: number | null;
    dailyApiKeyCapUsd: number | null;
  };
  /** Optional bounded presentation token; absent on legacy projects. */
  color?: ProjectColor;
  pinned: boolean;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectCatalog {
  version: 1;
  /** Compare before a write; every successful write advances it once. */
  revision: number;
  projects: ProjectRecord[];
  /** Private durable create identities; projected out of every catalog API response. */
  createOperations?: ProjectCreateOperation[];
  /** Private durable deletion identities; never projected by catalog-list routes. */
  deletedProjects?: ProjectDeletion[];
}

export interface ProjectDeletion {
  requestId: string;
  requestHash: string;
  expectedRevision: number;
  deletedRevision: number;
  deletedAt: string;
  project: ProjectRecord;
}

export type ProjectCreateState =
  | "reserved"
  | "created"
  | "retired-before-create";

/** Private, strict same-catalog original; never returned by project-list routes. */
export interface ProjectCreateOperation {
  requestId: string;
  requestHash: string;
  original: NewProject;
  baseRevision: number;
  scopeHash: string;
  scopeCount: number;
  state: ProjectCreateState;
  projectId: string | null;
  createdRevision: number | null;
  createdAt: string;
  updatedAt: string;
}

export type NewProject = Pick<
  ProjectRecord,
  "slug" | "name" | "description" | "icon" | "workspaces"
> & { keeperSmith?: string | undefined; color?: ProjectColor | undefined };

export interface ProjectPreferences {
  pinned?: boolean;
  archived?: boolean;
}
