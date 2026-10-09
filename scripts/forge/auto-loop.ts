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

import type { AutoDecision } from "./review-rules";

/**
 * The decision rules moved to `review-rules.ts` so the registry and the
 * dashboard bundle can read them; they are re-exported for existing callers.
 */
export {
  type AutoAction,
  type AutoDecision,
  DEFAULT_MAX_REVISIONS,
  decideNext,
} from "./review-rules";
/** The ledger's shape lives with the run's state; the rules live here. */
export type { ReviewFindings, ReviewRound };

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

/**
 * The Beads comment a round records, under the harness's `review:` prefix.
 * `legacy` marks a round graded from a schema 1 verdict, which names neither
 * the run nor the evaluator.
 */
export function reviewComment(
  round: ReviewRound,
  opts: { legacy?: boolean } = {},
): string {
  const { blocker, high, medium, low } = round.findings;
  return `review: ${round.verdict} — ${blocker} blocker, ${high} high, ${medium} medium, ${low} low (${round.phase} round ${round.round}${opts.legacy ? "; legacy verdict" : ""})`;
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
