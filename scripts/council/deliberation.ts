import { hashText } from "./context";
import type {
  AggregatedFinding,
  CouncilProfile,
  CouncilSeat,
  FindingSeverity,
  IndependentOutput,
  PeerBallot,
  PeerCandidate,
  ProposedFinding,
  SeatRecord,
} from "./types";

const SEVERITY_RANK: Record<FindingSeverity, number> = {
  blocker: 0,
  high: 1,
  medium: 2,
  low: 3,
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function anonymizeText(value: string, profile: CouncilProfile): string {
  const identities = [
    ...profile.seats.flatMap((seat) => [
      seat.id,
      seat.role,
      seat.provider,
      seat.model,
    ]),
    profile.chair.id,
    profile.chair.role,
    profile.chair.provider,
    profile.chair.model,
  ]
    .filter((identity) => identity.trim().length >= 3)
    .sort((a, b) => b.length - a.length);
  let result = value;
  for (const identity of identities) {
    // Strip explicit author introductions, never domain facts such as
    // "OpenAI credentials" or ordinary words matching a seat ID.
    result = result.replace(
      new RegExp(
        `^(?:I am|As(?: an?| the)?) ${escapeRegExp(identity)}(?: model)?[,.:]\\s*`,
        "i",
      ),
      "",
    );
  }
  return result;
}

function anonymizeFinding(
  finding: ProposedFinding,
  localId: string,
  profile: CouncilProfile,
): ProposedFinding {
  return {
    localId,
    title: anonymizeText(finding.title, profile),
    severity: finding.severity,
    claim: anonymizeText(finding.claim, profile),
    consequence: anonymizeText(finding.consequence, profile),
    evidenceIds: finding.evidenceIds,
    confidence: finding.confidence,
  };
}

function findingFingerprint(finding: ProposedFinding): string {
  const normalized = [
    finding.title,
    finding.claim,
    finding.consequence,
    [...finding.evidenceIds].sort().join(","),
  ]
    .join("|")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
  return hashText(normalized).slice(0, 16);
}

function deterministicOrder<T>(values: T[], seed: string): T[] {
  return values
    .map((value, index) => ({
      value,
      sortKey: hashText(`${seed}|${index}`),
    }))
    .sort((left, right) => left.sortKey.localeCompare(right.sortKey))
    .map((entry) => entry.value);
}

function responseLabel(index: number): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  return alphabet[index] ?? `R${index + 1}`;
}

export type IndependentSuccess = SeatRecord & {
  stage: "independent";
  status: "completed";
  output: IndependentOutput;
};

export function isIndependentSuccess(
  record: SeatRecord,
): record is IndependentSuccess {
  return (
    record.stage === "independent" &&
    record.status === "completed" &&
    record.output !== undefined &&
    "findings" in record.output
  );
}

export function preparePeerCandidates(
  successes: IndependentSuccess[],
  reviewer: CouncilSeat,
  profile: CouncilProfile,
  runId: string,
  peers: SeatRecord[] = [],
): { candidates: PeerCandidate[] } {
  const { aggregates: proposals } = clusterProposals(successes, peers, profile);
  const ordered = deterministicOrder(
    [...proposals.entries()].filter(
      ([, proposal]) => !proposal.authors.has(reviewer.id),
    ),
    `${runId}|${reviewer.id}`,
  );
  const candidates: PeerCandidate[] = [];
  ordered.forEach(([key, proposal], responseIndex) => {
    const label = `Response ${responseLabel(responseIndex)}`;
    const candidateId = `C-${key}`;
    candidates.push({
      candidateId,
      responseLabel: label,
      finding: anonymizeFinding(
        proposal.representative,
        `F${responseIndex + 1}`,
        profile,
      ),
    });
  });
  return { candidates };
}

type MutableAggregate = {
  representative: ProposedFinding;
  authors: Set<string>;
  independentAuthors: Set<string>;
  proposals: Map<string, ProposedFinding>;
};

function collectProposals(
  independent: IndependentSuccess[],
  peers: SeatRecord[],
): Map<string, MutableAggregate> {
  const aggregates = new Map<string, MutableAggregate>();
  const addProposal = (
    finding: ProposedFinding,
    author: string,
    isIndependent: boolean,
  ): void => {
    const key = findingFingerprint(finding);
    const aggregate = aggregates.get(key) ?? {
      representative: finding,
      authors: new Set<string>(),
      independentAuthors: new Set<string>(),
      proposals: new Map<string, ProposedFinding>(),
    };
    aggregate.authors.add(author);
    if (isIndependent) aggregate.independentAuthors.add(author);
    aggregate.proposals.set(author, finding);
    aggregates.set(key, aggregate);
  };
  for (const record of independent) {
    for (const finding of record.output.findings)
      addProposal(finding, record.seatId, true);
  }
  for (const record of peers) {
    if (
      record.status !== "completed" ||
      !record.output ||
      !("ballots" in record.output)
    )
      continue;
    for (const finding of record.output.missingFindings)
      addProposal(finding, record.seatId, false);
  }
  return aggregates;
}

export function reviewerLabel(profile: CouncilProfile, seatId: string): string {
  const index = profile.seats.findIndex((seat) => seat.id === seatId);
  return index < 0 ? "Reviewer ?" : `Reviewer ${index + 1}`;
}

function clusterProposals(
  independent: IndependentSuccess[],
  peers: SeatRecord[],
  profile: CouncilProfile,
): {
  aggregates: Map<string, MutableAggregate>;
  aliases: Map<string, string>;
} {
  const base = collectProposals(independent, peers);
  const parent = new Map([...base.keys()].map((key) => [key, key]));
  const find = (key: string): string => {
    const next = parent.get(key) ?? key;
    if (next === key) return key;
    const root = find(next);
    parent.set(key, root);
    return root;
  };
  const union = (left: string, right: string): void => {
    const a = find(left),
      b = find(right);
    if (a === b) return;
    const [root, child] = [a, b].sort();
    parent.set(child!, root!);
  };
  const votes = new Map<string, Set<string>>();
  for (const record of peers) {
    if (
      record.status !== "completed" ||
      !record.output ||
      !("equivalentCandidateGroups" in record.output)
    )
      continue;
    for (const group of record.output.equivalentCandidateGroups) {
      const keys = group.map((id) => id.replace(/^C-/, "")).sort();
      for (let left = 0; left < keys.length; left += 1)
        for (let right = left + 1; right < keys.length; right += 1) {
          const a = keys[left]!,
            b = keys[right]!;
          const first = base.get(a),
            second = base.get(b);
          if (
            !first ||
            !second ||
            first.authors.has(record.seatId) ||
            second.authors.has(record.seatId)
          )
            continue;
          const pair = `${a}|${b}`;
          const reviewers = votes.get(pair) ?? new Set<string>();
          reviewers.add(record.seatId);
          votes.set(pair, reviewers);
        }
    }
  }
  for (const [pair, reviewers] of votes) {
    const [a, b] = pair.split("|") as [string, string];
    const first = base.get(a)!,
      second = base.get(b)!;
    const eligible = independent.filter(
      (record) =>
        !first.authors.has(record.seatId) && !second.authors.has(record.seatId),
    ).length;
    if (
      eligible > 0 &&
      reviewers.size >= Math.min(profile.minPeerBallots, eligible)
    )
      union(a, b);
  }
  const aliases = new Map<string, string>();
  const aggregates = new Map<string, MutableAggregate>();
  for (const [key, aggregate] of base) {
    const root = find(key);
    aliases.set(key, root);
    const merged = aggregates.get(root) ?? {
      representative: aggregate.representative,
      authors: new Set<string>(),
      independentAuthors: new Set<string>(),
      proposals: new Map<string, ProposedFinding>(),
    };
    aggregate.authors.forEach((author) => {
      merged.authors.add(author);
    });
    aggregate.independentAuthors.forEach((author) => {
      merged.independentAuthors.add(author);
    });
    aggregate.proposals.forEach((finding, author) => {
      merged.proposals.set(author, finding);
    });
    aggregates.set(root, merged);
  }
  return { aggregates, aliases };
}

export function aggregateFindings(
  independent: IndependentSuccess[],
  peers: SeatRecord[],
  profile: CouncilProfile,
): AggregatedFinding[] {
  const { aggregates, aliases } = clusterProposals(independent, peers, profile);
  const votes = new Map<string, Map<string, PeerBallot>>();
  for (const record of peers) {
    if (
      record.status !== "completed" ||
      !record.output ||
      !("ballots" in record.output)
    )
      continue;
    for (const ballot of record.output.ballots) {
      const rawKey = ballot.candidateId.replace(/^C-/, "");
      const key = aliases.get(rawKey) ?? rawKey;
      const proposal = aggregates.get(key);
      if (!proposal || proposal.authors.has(record.seatId)) continue;
      const byReviewer = votes.get(key) ?? new Map<string, PeerBallot>();
      // Later rounds revise a reviewer's ballot; they never add extra votes.
      byReviewer.set(record.seatId, ballot);
      votes.set(key, byReviewer);
    }
  }
  return [...aggregates.entries()]
    .map(([key, aggregate]) => {
      const ballots = [...(votes.get(key)?.entries() ?? [])];
      const support = ballots.filter(
        ([, ballot]) => ballot.stance === "support",
      ).length;
      const oppose = ballots.filter(
        ([, ballot]) => ballot.stance === "oppose",
      ).length;
      const uncertain = ballots.filter(
        ([, ballot]) => ballot.stance === "uncertain",
      ).length;
      const corroborated =
        aggregate.independentAuthors.size >= profile.minQuorum;
      const reviewed =
        corroborated ||
        (profile.depth !== "quick" && ballots.length >= profile.minPeerBallots);
      const proposals = [...aggregate.proposals.values()];
      const originalSeverity = proposals
        .map((f) => f.severity)
        .sort((a, b) => SEVERITY_RANK[a] - SEVERITY_RANK[b])[0]!;
      const supportedSeverities = ballots
        .filter(([, ballot]) => ballot.stance === "support")
        .map(([, ballot]) => ballot.suggestedSeverity ?? originalSeverity);
      const peerSeverityResolved =
        support >= profile.minPeerBallots &&
        profile.depth !== "quick" &&
        new Set(supportedSeverities).size === 1 &&
        oppose === 0 &&
        uncertain === 0;
      const severityDisputed =
        !peerSeverityResolved &&
        (new Set(supportedSeverities).size > 1 ||
          new Set(proposals.map((proposal) => proposal.severity)).size > 1);
      // A unanimous, quorate peer correction can raise or lower severity.
      // Preserve the conservative original when peers disagree or lack quorum.
      const severity = peerSeverityResolved
        ? (supportedSeverities[0] ?? originalSeverity)
        : originalSeverity;
      const consensusEligible =
        reviewed &&
        (corroborated || support >= profile.minPeerBallots) &&
        oppose === 0 &&
        uncertain === 0 &&
        !severityDisputed;
      const rejected =
        reviewed &&
        oppose >= profile.minPeerBallots &&
        support === 0 &&
        uncertain === 0;
      const resolution: AggregatedFinding["resolution"] = consensusEligible
        ? "consensus"
        : rejected
          ? "rejected"
          : !reviewed
            ? "unreviewed"
            : "contested";
      return {
        key,
        title: anonymizeText(aggregate.representative.title, profile),
        claim: anonymizeText(aggregate.representative.claim, profile),
        consequence: anonymizeText(
          aggregate.representative.consequence,
          profile,
        ),
        severity,
        evidenceIds: [...new Set(aggregate.representative.evidenceIds)].sort(),
        confidence: Number(
          (
            proposals.reduce((sum, f) => sum + f.confidence, 0) /
            proposals.length
          ).toFixed(3),
        ),
        proposedBy: aggregate.authors.size,
        independentProposers: aggregate.independentAuthors.size,
        support,
        oppose,
        uncertain,
        contested: !consensusEligible,
        reviewed,
        consensusEligible,
        resolution,
        severityDisputed,
        rationales: ballots.map(([seatId, ballot]) => ({
          reviewerLabel: reviewerLabel(profile, seatId),
          stance: ballot.stance,
          reason: anonymizeText(ballot.reason, profile),
          evidenceIds: ballot.evidenceIds,
          ...(ballot.suggestedSeverity
            ? { suggestedSeverity: ballot.suggestedSeverity }
            : {}),
        })),
      };
    })
    .sort((left, right) => {
      const severity =
        SEVERITY_RANK[left.severity] - SEVERITY_RANK[right.severity];
      if (severity !== 0) return severity;
      if (left.support !== right.support) return right.support - left.support;
      return left.title.localeCompare(right.title);
    });
}
