/**
 * The decision engine for unattended Forge runs (`/forgemaster-auto`).
 *
 * In auto mode each phase runs work → a fresh evaluator subagent reviews the
 * output → the findings come back as feedback → the phase is revised. Nobody is
 * watching, so the rules for "advance, revise again, or stop" have to be
 * written down and testable rather than improvised turn by turn.
 *
 * Three properties matter more than throughput:
 *
 *   1. **A phase never advances unreviewed.** No review, no advance.
 *   2. **The loop is bounded.** A fixed revision budget, and an early stop as
 *      soon as findings stop shrinking — an unattended agent that is not
 *      converging is burning money, not making progress.
 *   3. **Stopping is legible.** Every halt names what blocked it and the
 *      command that resumes the work.
 *
 * Pure functions only; `auto-loop-cli.ts` is what touches disk.
 */

import type { EvalVerdictParsed } from "../eval-verdict";
import { phaseCommand } from "./phase-gate";
import type {
  ForgePhase,
  ForgeState,
  ReviewFindings,
  ReviewRound,
} from "./phases";

/** The ledger's shape lives with the run's state; the rules live here. */
export type { ReviewFindings, ReviewRound };

/** How many times a phase may be revised before the run stops for a human. */
export const DEFAULT_MAX_REVISIONS = 2;

export type AutoAction = "advance" | "revise" | "halt";

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

const NO_FINDINGS: ReviewFindings = {
  blocker: 0,
  high: 0,
  medium: 0,
  low: 0,
};

/** Turn an evaluator verdict (or a failure to read one) into a review round. */
export function roundFromVerdict(input: {
  phase: ForgePhase;
  history: readonly ReviewRound[];
  verdict: EvalVerdictParsed | null;
  at: string;
  tier?: string;
}): ReviewRound {
  const round = input.history.filter((r) => r.phase === input.phase).length + 1;
  return {
    phase: input.phase,
    round,
    verdict: input.verdict?.verdict ?? "UNREADABLE",
    findings: input.verdict?.findings ?? NO_FINDINGS,
    ...(input.tier ? { tier: input.tier } : {}),
    ...(input.verdict?.summary ? { summary: input.verdict.summary } : {}),
    at: input.at,
  };
}

/** The run state with one more review round on its ledger. */
export function recordRound(state: ForgeState, round: ReviewRound): ForgeState {
  return { ...state, reviews: [...(state.reviews ?? []), round] };
}

/** The Beads comment a round records, under the harness's `review:` prefix. */
export function reviewComment(round: ReviewRound): string {
  const { blocker, high, medium, low } = round.findings;
  return `review: ${round.verdict} — ${blocker} blocker, ${high} high, ${medium} medium, ${low} low (${round.phase} round ${round.round})`;
}

/**
 * What a halted auto run leaves behind for the next session.
 *
 * @see .claude/protocols/session-handoff.md
 */
export function haltHandoff(input: {
  slug: string;
  phase: ForgePhase;
  decision: AutoDecision;
  history: readonly ReviewRound[];
}): string {
  const rounds = input.history.filter((r) => r.phase === input.phase);
  const ledger = rounds
    .map(
      (r) =>
        `| ${r.round} | ${r.verdict} | ${r.findings.blocker} | ${r.findings.high} | ${r.findings.medium} | ${r.findings.low} |`,
    )
    .join("\n");

  return `# Session handoff — auto run "${input.slug}" stopped in ${input.phase}

**Why it stopped:** ${input.decision.reason}

An unattended run stops instead of grinding, so the work is intact and
reviewable — nothing was force-advanced past a failing review.

## Review rounds for this phase

| Round | Verdict | Blocker | High | Medium | Low |
|-------|---------|---------|------|--------|-----|
${ledger}

## Resume

1. Read the latest evaluator findings for this phase and decide whether they are real.
2. Fix them, or narrow the phase's scope so they no longer apply.
3. Re-run the phase: \`${phaseCommand(input.phase, input.slug)}\`.
4. Continue unattended with \`/forgemaster-auto ${input.slug}\`, or take it back
   under gates with \`/forgemaster ${input.slug}\`.
`;
}
