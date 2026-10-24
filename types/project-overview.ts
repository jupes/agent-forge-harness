import type { ListedShift } from "../scripts/scheduler/shift-store";
import type { BeadsIssue } from "./beads";
import type { ProviderUsage, Reservation } from "./hearth";
import type { ProjectSummary } from "./project-summary";

export interface ProjectObservation<T> {
  data: T | null;
  source: string;
  asOf: string;
  complete: boolean;
  reason: string | null;
}
export interface ProjectOverview {
  summary: ProjectSummary;
  beads: BeadsIssue[];
  epics: { id: string; title: string; closed: number; total: number }[];
  reservations: ProjectObservation<Reservation[]>;
  shifts: ProjectObservation<ListedShift[]>;
  throughput: ProjectObservation<{ date: string; count: number }[]>;
  usage: ProjectObservation<
    { provider: string; sessions: number; usage: ProviderUsage }[]
  >;
}
