import type {
  GateRun,
  PhaseRow,
  RunBoardRow,
} from "../scripts/dashboard/forge-run-model";
import type { ReviewRound } from "../scripts/forge/phases";
import type { SessionKind } from "./hearth";

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

export interface ProjectRunRecordedSession {
  sessionId: string;
  startedAt: string;
  kind: SessionKind | null;
  /** Current project metadata independently admits opening the protected session view. */
  detailsAvailable: boolean;
}

export type ProjectRunSessionHistory =
  | {
      status: "available";
      after: number;
      nextAfter: number;
      more: boolean;
      /** Opaque digest of the current run and project/session admission facts. */
      membershipKey: string;
      sessions: ProjectRunRecordedSession[];
    }
  | {
      status: "unavailable";
      after: number;
      reason: "ledger-unavailable" | "unsupported-server";
    };

export interface ProjectRunDetail extends ProjectRunSource {
  run: ProjectRunRow;
  reviews: (Pick<
    ReviewRound,
    "phase" | "round" | "verdict" | "findings" | "at"
  > & { summary: string | null })[];
  gateHistory: ProjectRunGate[];
  gateHistoryDays: 30;
  earlierGateLimit: 10;
  /** Missing only in a legacy server response; the client treats it as unavailable. */
  sessionHistory?: ProjectRunSessionHistory;
}

/** A complete, verified document from the served checkout, fetched on demand. */
export interface ProjectRunArtifact extends ProjectRunSource {
  slug: string;
  kind: "research" | "plan" | "ship";
  artifact: string;
  bytes: number;
  sha256: string;
  content: string;
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
