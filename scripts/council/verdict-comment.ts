import { councilOutcome } from "./ledger-events";
import type { CouncilServiceJob } from "./service";
import type { CouncilRun } from "./types";

/** What the comment counts, in the order it counts them. */
const SEVERITIES = ["blocker", "high", "medium", "low"] as const;

/** An ended job as the comment reads it: its id, its status and its run. */
export type EndedCouncilJob = Pick<CouncilServiceJob, "runId" | "status"> & {
  run?: Pick<CouncilRun, "status" | "chair" | "aggregatedFindings">;
};

/**
 * The `review:` comment a run posts to its bead, or null when it posts none.
 *
 * Only a completed run has one: `review: COUNCIL <run id> <OUTCOME> — findings
 * <b>/<h>/<m>/<l> (blocker/high/medium/low)`. The outcome is the one the
 * ledger records for the run (`councilOutcome`), in capitals, so the comment
 * and `council.run.finished` say the same; the counts are the run's
 * aggregated findings by severity, all of them, as its report lists them.
 */
export function councilVerdictComment(job: EndedCouncilJob): string | null {
  const run = job.run;
  if (job.status !== "completed" || run === undefined) return null;
  if (run.status !== "completed") return null;
  const counts = SEVERITIES.map(
    (severity) =>
      run.aggregatedFindings.filter((finding) => finding.severity === severity)
        .length,
  );
  return `review: COUNCIL ${job.runId} ${councilOutcome(run).toUpperCase()} — findings ${counts.join("/")} (${SEVERITIES.join("/")})`;
}
