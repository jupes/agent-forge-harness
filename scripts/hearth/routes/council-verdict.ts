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

import type {
  CouncilServiceInput,
  createCouncilService,
} from "../../council/service";
import { councilVerdictComment } from "../../council/verdict-comment";
import type { RouteReply } from "../api";
import { type BeadDeps, commentOnBead } from "./beads";

export {
  councilVerdictComment,
  type EndedCouncilJob,
} from "../../council/verdict-comment";

type CouncilService = ReturnType<typeof createCouncilService>;

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
