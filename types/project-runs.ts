import type {
  GateRun,
  PhaseRow,
  RunBoardRow,
} from "../scripts/dashboard/forge-run-model";
import type { ReviewRound } from "../scripts/forge/phases";

/** Existing pure run selectors, with unavailable route/start facts left unreported. */
export interface ProjectRunRow extends RunBoardRow {
  complete: boolean;
  phases: PhaseRow[];
}

export interface ProjectRunSource {
  version: 1;
  projectId: string;
  workspace: string;
  checkout: string;
  asOf: string;
  coverage: "served-checkout-only";
  problems: string[];
}

export interface ProjectRunsPage extends ProjectRunSource {
  runs: ProjectRunRow[];
}

export interface ProjectRunDetail extends ProjectRunSource {
  run: ProjectRunRow;
  reviews: (Pick<
    ReviewRound,
    "phase" | "round" | "verdict" | "findings" | "at"
  > & { summary: string | null })[];
  gateHistory: ProjectRunGate[];
  gateHistoryDays: 30;
  earlierGateLimit: 10;
}

/** Only bounded gate metadata from matching recorded run/checkout evidence. */
export interface ProjectRunGate
  extends Pick<
    GateRun,
    | "event"
    | "timestamp"
    | "passed"
    | "checks"
    | "checkout"
    | "branch"
    | "link"
    | "beadsIssueId"
    | "executionRunId"
    | "forgeSlug"
  > {
  evaluatorEvidence: "schema-2" | "legacy" | null;
}
