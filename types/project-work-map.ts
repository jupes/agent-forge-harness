import type { BeadsDependency, IssueType } from "./beads";
import type { QueueState } from "./hearth";

export const WORK_MAP_STATES = [
  "working",
  "in_progress",
  "ready",
  "not_started",
  "blocked",
  "completed",
  "other",
] as const;
export type WorkMapState = (typeof WORK_MAP_STATES)[number];

export interface ProjectWorkMapProject {
  id: string;
  name: string;
  archived: boolean;
  /** Partial means only known local scope is represented. */
  availability: "available" | "partial" | "unavailable";
}

export interface ProjectWorkMapEpic {
  id: string;
  projectId: string;
  title: string;
  parentId: string | null;
}

export interface ProjectWorkMapBead {
  id: string;
  title: string;
  type: IssueType;
  status: string;
  workState: WorkMapState;
  memberships: { projectId: string; epicId: string | null }[];
  parentId: string | null;
  updatedAt: string;
  /** An explicitly recorded outcome for completed work; absent stays null. */
  delivery: string | null;
  queue: QueueState | null;
}

/** One authorized tracker, with unknown catalog scope kept visible. */
export interface ProjectWorkMap {
  asOf: string;
  trackerAvailable: boolean;
  sessionsComplete: boolean;
  projects: ProjectWorkMapProject[];
  epics: ProjectWorkMapEpic[];
  beads: ProjectWorkMapBead[];
  dependencies: BeadsDependency[];
}
