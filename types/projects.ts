/** Hearth-level project contract. Records contain metadata, never provider credentials. */
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
}

export type NewProject = Pick<
  ProjectRecord,
  "slug" | "name" | "description" | "icon" | "workspaces"
>;

export interface ProjectPreferences {
  pinned?: boolean;
  archived?: boolean;
}
