import type { OperatorMove } from "../scripts/scheduler/queue-table";
import type { BenchName, QueueEntry } from "./hearth";

export interface ProjectWorkbenchCard {
  entry: QueueEntry;
  moves: OperatorMove[];
  complexity: BenchName | null;
  smith: {
    name: string | null;
    via: "bead" | "bench" | "default" | null;
    reason: string | null;
  };
  updatedAt: string;
  note: string | null;
  eligibility: {
    may: boolean | null;
    reason: string;
    waitsOn: string | null;
  } | null;
  session: {
    id: string;
    provider: string | null;
    worktree: string | null;
    startedAt: string | null;
  } | null;
}
export interface ProjectWorkbenchHost {
  busy: boolean;
  cpu: number | null;
  memory: number;
  threshold: number;
  reason?: string | undefined;
}
export interface ProjectWorkbenchPage {
  projectId: string;
  workspace: string;
  asOf: string;
  complete: boolean;
  problems: string[];
  cards: ProjectWorkbenchCard[];
  smiths: { names: string[]; defaultSmith: string | null } | null;
  host: ProjectWorkbenchHost | null;
}
