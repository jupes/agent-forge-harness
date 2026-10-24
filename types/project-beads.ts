import type { BeadsDependency, IssueType } from "./beads";
import type { QueueState } from "./hearth";

/** A scoped live tracker read; numeric priority and raw status are preserved. */
export interface ProjectBead {
  id: string;
  title: string;
  type: IssueType;
  status: string;
  priority: 0 | 1 | 2 | 3 | 4 | null;
  parent: string | null;
  assignee: string | null;
  owner: string | null;
  labels: string[];
  createdAt: string;
  updatedAt: string;
  due: string | null;
  description: string;
  acceptanceCriteria: string;
  estimate: number | null;
  spent: number | null;
  ready: boolean;
  blocked: boolean;
  blockers: string[];
  unavailableBlockers: number;
  queue: QueueState | null;
  smith: string | null;
  comments: { body: string; author: string; createdAt: string }[];
  commentsComplete: boolean;
  detailsLoaded: boolean;
  fileMap: string[] | null;
  fileMapReason: string | null;
  reservations:
    | {
        worktree: string;
        globs: string[];
        acquiredAt: string;
        sessionId: string | null;
      }[]
    | null;
  activity:
    | { id: number; kind: string; ts: string; sessionId: string | null }[]
    | null;
  activityComplete: boolean;
}
export interface ProjectBeadsPage {
  projectId: string;
  workspace: string;
  asOf: string;
  complete: boolean;
  problems: string[];
  beads: ProjectBead[];
  dependencies: BeadsDependency[];
}
