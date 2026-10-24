import type { RunSummary } from "../scripts/forge/runs";
import type { BeadCounts, QueueState, SessionSummary } from "./hearth";
import type { ProjectCatalog } from "./projects";

/** A point-in-time read. Missing sources never become zero counts. */
export interface ProjectSummary {
  projectId: string;
  workspace: string;
  asOf: string;
  complete: boolean;
  problems: string[];
  beads: BeadCounts | null;
  queue: Record<QueueState, number> | null;
  needsYou: { beadId: string; title: string; state: QueueState }[];
  sessions: SessionSummary[];
  sessionsComplete: boolean;
  /** Observations from this checkout only; absence does not prove no workspace runs. */
  runs: RunSummary[];
  lastActivity: string | null;
}

export interface ProjectsHome {
  catalog: ProjectCatalog;
  summaries: ProjectSummary[];
  asOf: string;
}
