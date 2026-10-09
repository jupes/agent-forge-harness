/**
 * Grader >= subject, as a rule the harness can check.
 *
 * `.claude/protocols/model-tier-policy.md` asks that an evaluator run at or
 * above the rank that built the work under review. A rank is a `rank:*` tag on
 * a configured smith, so a provider and model have a rank only through the
 * smiths that use them. The verdict's writer applies `rankPolicy` and records
 * the decision; the strict gate applies it again to what the verdict says was
 * observed.
 *
 * Nothing here touches disk.
 */

import {
  type EvaluatorIdentity,
  RANKS,
  type Rank,
  type RankPolicyDecision,
  type Smith,
} from "../types/hearth";

/** A provider and model, and the smith that resolved to them when one did. */
export interface RankedExecutor {
  provider: string;
  model: string;
  smith?: string;
}

export type RankPolicyRule =
  | "evaluator-at-or-above-builder"
  | "master-evaluator-builder-unknown"
  | "evaluator-below-builder"
  | "evaluator-rank-unknown"
  | "builder-rank-unknown";

export interface RankPolicy {
  decision: RankPolicyDecision;
  rule: RankPolicyRule;
}

const RANK_TAG = "rank:";

/** The rank a smith is tagged with, or null when it has no (or no known) rank tag. */
function smithRank(smith: Smith): Rank | null {
  for (const tag of smith.tags) {
    if (!tag.startsWith(RANK_TAG)) continue;
    const rank = RANKS.find((known) => known === tag.slice(RANK_TAG.length));
    if (rank !== undefined) return rank;
  }
  return null;
}

/**
 * The rank of a provider and model: that of the smith the executor names, when
 * that smith is this provider and model; else that of the configured smiths
 * using them. Smiths of different ranks can share a model (the same model at
 * two efforts), so the caller says which end to take: the lowest for an
 * evaluator and the highest for a builder, the reading least favourable to
 * "grader >= subject". Null when no ranked smith uses the model.
 */
export function rankOf(
  smiths: readonly Smith[],
  who: RankedExecutor,
  prefer: "lowest" | "highest",
): Rank | null {
  const using = smiths.filter(
    (smith) => smith.provider === who.provider && smith.model === who.model,
  );
  const named = using.find((smith) => smith.name === who.smith);
  const positions = (named ? [named] : using)
    .map(smithRank)
    .filter((rank): rank is Rank => rank !== null)
    .map((rank) => RANKS.indexOf(rank));
  if (positions.length === 0) return null;
  const position =
    prefer === "lowest" ? Math.min(...positions) : Math.max(...positions);
  return RANKS[position] ?? null;
}

/**
 * Whether an evaluator of one rank may grade a builder of another. An unknown
 * evaluator rank is never allowed. With the builder's rank unknown only the
 * top rank is: the one rank that is at or above any builder.
 */
export function rankPolicy(input: {
  evaluator: Rank | null;
  builder: Rank | null;
}): RankPolicy {
  const { evaluator, builder } = input;
  if (evaluator === null) {
    return { decision: "rejected", rule: "evaluator-rank-unknown" };
  }
  if (builder === null) {
    return RANKS.indexOf(evaluator) === RANKS.length - 1
      ? { decision: "allowed", rule: "master-evaluator-builder-unknown" }
      : { decision: "rejected", rule: "builder-rank-unknown" };
  }
  return RANKS.indexOf(evaluator) >= RANKS.indexOf(builder)
    ? { decision: "allowed", rule: "evaluator-at-or-above-builder" }
    : { decision: "rejected", rule: "evaluator-below-builder" };
}

/** What the rank policy says of an observed evaluator, with the ranks it used. */
export function observedRankPolicy(input: {
  observed: RankedExecutor;
  builder?: RankedExecutor;
  smiths: readonly Smith[];
}): RankPolicy & { evaluatorRank: Rank | null; builderRank: Rank | null } {
  const evaluatorRank = rankOf(input.smiths, input.observed, "lowest");
  const builderRank = input.builder
    ? rankOf(input.smiths, input.builder, "highest")
    : null;
  return {
    ...rankPolicy({ evaluator: evaluatorRank, builder: builderRank }),
    evaluatorRank,
    builderRank,
  };
}

/**
 * Why an evaluator does not satisfy strict completion, or null when it does.
 *
 * A human does, by declaring an actor kind. A model must have been observed,
 * must not carry its own rejection, and its observed provider and model must
 * pass the rank policy as computed here: the verdict's own "allowed" is not
 * taken on trust, and the requested provider, model and rank are never used.
 */
export function strictEvaluatorProblem(
  evaluator: EvaluatorIdentity,
  context: { smiths: readonly Smith[]; builder?: RankedExecutor },
): string | null {
  if (evaluator.kind === "human") return null;
  if (
    evaluator.observedProvider === undefined ||
    evaluator.observedModel === undefined
  ) {
    return `the verdict records no observed evaluator provider and model (requested ${evaluator.requestedProvider}/${evaluator.requestedModel} is not evidence of what ran)`;
  }
  if (evaluator.rankPolicyDecision !== "allowed") {
    return `the verdict records its own rank-policy decision as rejected (${evaluator.rankPolicyRule})`;
  }
  const observed = `${evaluator.observedProvider}/${evaluator.observedModel}`;
  const policy = observedRankPolicy({
    observed: {
      provider: evaluator.observedProvider,
      model: evaluator.observedModel,
    },
    ...(context.builder ? { builder: context.builder } : {}),
    smiths: context.smiths,
  });
  switch (policy.rule) {
    case "evaluator-at-or-above-builder":
    case "master-evaluator-builder-unknown":
      return null;
    case "evaluator-rank-unknown":
      return `observed evaluator ${observed} has no rank: no configured smith with a rank:* tag uses that provider and model`;
    case "evaluator-below-builder":
      return `observed evaluator ${observed} (rank ${policy.evaluatorRank}) is below the builder's rank (${policy.builderRank})`;
    case "builder-rank-unknown":
      return `the run records no builder whose rank is known, so only a master evaluator satisfies grader >= subject; observed evaluator ${observed} is rank ${policy.evaluatorRank}`;
  }
}
