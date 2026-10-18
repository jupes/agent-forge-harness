/**
 * The verdict of a council run on a bead, posted back to that bead
 * (`x1gs.7.2`).
 *
 * When the start row (`council.run.start`, `./operator.ts`) has started a run
 * whose source is a bead, it hands the run here: the run is waited for, and a
 * completed run's verdict becomes one `review:` comment on the bead, written
 * by the comment row's own tracker write (`commentOnBead` in `./beads.ts`):
 * every value after `--`, one call, never repeated, `bead.transitioned` once
 * bd's answer confirms it. A failed or cancelled run reached no verdict and
 * posts nothing at all, so nothing on the bead can be read as one. The start's
 * audit row, recorded against the bead, is the record of who asked; nothing
 * else is audited here.
 */

import { councilOutcome } from "../../council/ledger-events";
import type {
  CouncilServiceInput,
  CouncilServiceJob,
  createCouncilService,
} from "../../council/service";
import type { CouncilRun } from "../../council/types";
import type { RouteReply } from "../api";
import { type BeadDeps, commentOnBead } from "./beads";

type CouncilService = ReturnType<typeof createCouncilService>;

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

export interface VerdictDeps extends BeadDeps {
  council: Pick<CouncilService, "wait">;
}

/**
 * Wait for a run the hearth started and post its verdict to the bead under
 * review: the comment write's reply, or null when nothing was written (the
 * source is not a bead, or the run reached no verdict). Never rejects.
 *
 * A run of another source that only names a bead to be recorded against it
 * posts nothing: its findings are about that source.
 */
export async function postCouncilVerdict(
  deps: VerdictDeps,
  input: Pick<CouncilServiceInput, "sourceType" | "beadId">,
  runId: string,
): Promise<RouteReply | null> {
  if (input.sourceType !== "bead" || input.beadId === undefined) return null;
  const beadId = input.beadId;
  try {
    const comment = councilVerdictComment(await deps.council.wait(runId));
    if (comment === null) return null;
    const reply = await commentOnBead(deps, beadId, comment);
    // Independent of bead.transitioned: bd can confirm a comment whose ledger
    // record was lost. Recording this outcome can never repeat the write.
    try {
      deps.appendEvent({
        kind: "council.verdict.comment",
        workspace: deps.workspace,
        beadId,
        payload: {
          councilRunId: runId,
          status:
            reply.status === 201
              ? "posted"
              : reply.status === 504
                ? "unknown"
                : "refused",
        },
      });
    } catch {}
    return reply;
  } catch {
    return null;
  }
}
