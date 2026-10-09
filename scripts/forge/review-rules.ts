/**
 * The rules an unattended Forge run is held to — the pure half.
 *
 * `decideNext` says what a run does after a review round; `reviewGate` reads a
 * run's whole state and says whether its reviews allow it to move on. Both are
 * needed wherever a run is described (the registry, the phase gate, the stop
 * reminder, the dashboard bundle), so this module imports nothing but the
 * run's shape: no Node built-in, no ledger.
 */

import {
  FORGE_PHASES,
  type ForgePhase,
  type ForgeState,
  type ReviewAction,
  type ReviewFindings,
  type ReviewRound,
} from "./phases";

/** How many times a phase may be revised before the run stops for a human. */
export const DEFAULT_MAX_REVISIONS = 2;

export type AutoAction = ReviewAction;

export interface AutoDecision {
  action: AutoAction;
  /** One sentence, written to be read in a log or a handoff. */
  reason: string;
  /** The round number the next review will carry, when revising. */
  nextRound?: number;
  /** Medium/low findings survive as follow-up Beads issues, not as blockers. */
  fileFollowUps: boolean;
}

const blocking = (findings: ReviewFindings): number =>
  findings.blocker + findings.high;

/** True when `latest` is no better than `previous` — the loop is stuck. */
function notImproving(latest: ReviewRound, previous: ReviewRound): boolean {
  if (latest.findings.blocker !== previous.findings.blocker) {
    return latest.findings.blocker > previous.findings.blocker;
  }
  return latest.findings.high >= previous.findings.high;
}

/**
 * What an unattended run does after a review round.
 *
 * `history` is every round recorded for the run; only this phase's rounds
 * count, because each phase gets its own budget.
 */
export function decideNext(input: {
  phase: ForgePhase;
  history: readonly ReviewRound[];
  maxRevisions?: number;
}): AutoDecision {
  const maxRevisions = input.maxRevisions ?? DEFAULT_MAX_REVISIONS;
  const rounds = input.history.filter((r) => r.phase === input.phase);
  const latest = rounds[rounds.length - 1];

  if (latest === undefined) {
    return {
      action: "halt",
      reason: `No review recorded for "${input.phase}" — an auto run does not advance a phase nobody reviewed.`,
      fileFollowUps: false,
    };
  }

  if (latest.verdict === "UNREADABLE") {
    return {
      action: "halt",
      reason: `The review of "${input.phase}" returned no usable verdict, so the run cannot grade itself. Check the evaluator output.`,
      fileFollowUps: false,
    };
  }

  const soft = latest.findings.medium + latest.findings.low > 0;

  if (latest.verdict === "PASS") {
    return {
      action: "advance",
      reason: `Review PASSED "${input.phase}"${soft ? " with medium/low findings to file" : ""}.`,
      fileFollowUps: soft,
    };
  }

  if (blocking(latest.findings) === 0) {
    // Matches the strict eval gate: only blocker/high stop the pipeline.
    return {
      action: "advance",
      reason: `Review of "${input.phase}" found no blocker or high findings; the rest become follow-up issues.`,
      fileFollowUps: true,
    };
  }

  const revisionsUsed = rounds.length - 1;
  if (revisionsUsed >= maxRevisions) {
    return {
      action: "halt",
      reason: `${maxRevisions} revision round${maxRevisions === 1 ? "" : "s"} did not clear "${input.phase}" (still ${latest.findings.blocker} blocker, ${latest.findings.high} high).`,
      fileFollowUps: false,
    };
  }

  const previous = rounds[rounds.length - 2];
  if (previous !== undefined && notImproving(latest, previous)) {
    return {
      action: "halt",
      reason: `Review of "${input.phase}" is not converging: round ${latest.round} is no better than round ${previous.round} (${latest.findings.blocker} blocker, ${latest.findings.high} high).`,
      fileFollowUps: false,
    };
  }

  return {
    action: "revise",
    reason: `Review FAILED "${input.phase}" with ${latest.findings.blocker} blocker and ${latest.findings.high} high findings; revising.`,
    nextRound: latest.round + 1,
    fileFollowUps: false,
  };
}

/** Whether a run's reviews let it move on, and which phase holds it if not. */
export type ReviewGate =
  | { status: "clear" }
  | { status: "awaiting-review"; phase: ForgePhase }
  | { status: "revise"; phase: ForgePhase; reason: string }
  | { status: "halted"; phase: ForgePhase; reason: string };

/**
 * What the review loop decided for a phase's latest round.
 *
 * The decision `forge:review` printed is stored on the round, because it
 * depends on a revision budget only that command saw. Rounds recorded before
 * decisions were stored are re-derived with the default budget.
 */
function latestDecision(
  phase: ForgePhase,
  latest: ReviewRound,
  history: readonly ReviewRound[],
): { action: AutoAction; reason: string } {
  if (latest.action !== undefined) {
    return {
      action: latest.action,
      reason:
        latest.reason ??
        `Review round ${latest.round} of "${phase}" was recorded as ${latest.action}.`,
    };
  }
  return decideNext({ phase, history });
}

/**
 * Do this run's reviews allow it to move on?
 *
 * Only auto runs are held: a gated run has a human at every boundary. The
 * phases looked at are the last completed one (which must have a review) and
 * any completed phase that has rounds, in pipeline order; the first that is
 * not clear decides. Nothing is stored to say "halted" — it is read from the
 * latest round each time, so only a new advancing round removes a halt.
 *
 * A run that recorded `ship` complete is finished: only a ship review that
 * was actually recorded and did not advance holds it.
 */
export function reviewGate(state: ForgeState): ReviewGate {
  if (state.mode !== "auto") return { status: "clear" };
  const history = state.reviews ?? [];
  const done = FORGE_PHASES.filter((phase) => state.completed.includes(phase));
  const last = done[done.length - 1];
  const shipped = state.completed.includes("ship");

  for (const phase of done) {
    if (shipped && phase !== "ship") continue;
    const rounds = history.filter((round) => round.phase === phase);
    const latest = rounds[rounds.length - 1];
    if (latest === undefined) {
      if (phase === last && !shipped) {
        return { status: "awaiting-review", phase };
      }
      continue;
    }
    const decision = latestDecision(phase, latest, history);
    if (decision.action === "halt") {
      return { status: "halted", phase, reason: decision.reason };
    }
    if (decision.action === "revise") {
      return { status: "revise", phase, reason: decision.reason };
    }
  }
  return { status: "clear" };
}
