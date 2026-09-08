import { sanitizeContent } from "./context";
import {
  ballotSchema,
  chairSchema,
  findingSchema,
  independentSchema,
  parseOutputContract,
  peerSchema,
} from "./output-contracts";
import type {
  AggregatedFinding,
  ChairOutput,
  IndependentOutput,
  PeerBallot,
  PeerOutput,
  ProposedFinding,
} from "./types";

function cleanModelText(value: string): string {
  return sanitizeContent(value.trim(), "redact").text;
}

function validateEvidenceIds(
  evidenceIds: string[],
  validEvidenceIds: ReadonlySet<string>,
  path: string,
  allowEmpty = false,
): void {
  if (!allowEmpty && evidenceIds.length === 0) {
    throw new Error(`${path} must cite at least one evidence ID`);
  }
  for (const evidenceId of evidenceIds) {
    if (!validEvidenceIds.has(evidenceId)) {
      throw new Error(`${path} contains unknown evidence ID: ${evidenceId}`);
    }
  }
}

function parseFinding(
  input: unknown,
  path: string,
  validEvidenceIds: ReadonlySet<string>,
): ProposedFinding {
  const value = parseOutputContract(findingSchema, input, path);
  validateEvidenceIds(
    value.evidenceIds,
    validEvidenceIds,
    `${path}.evidenceIds`,
  );
  return {
    localId: cleanModelText(value.localId),
    title: cleanModelText(value.title),
    severity: value.severity,
    claim: cleanModelText(value.claim),
    consequence: cleanModelText(value.consequence),
    evidenceIds: value.evidenceIds,
    confidence: value.confidence,
  };
}

export function parseIndependentOutput(
  input: unknown,
  validEvidenceIds: ReadonlySet<string>,
): IndependentOutput {
  const value = parseOutputContract(independentSchema, input, "independent");
  return {
    verdict: value.verdict,
    findings: value.findings.map((finding, index) =>
      parseFinding(finding, `findings[${index}]`, validEvidenceIds),
    ),
    strengths: value.strengths.map(cleanModelText),
    unknowns: value.unknowns.map(cleanModelText),
  };
}

function parsePeerBallot(
  input: unknown,
  path: string,
  validEvidenceIds: ReadonlySet<string>,
): PeerBallot {
  const value = parseOutputContract(ballotSchema, input, path);
  validateEvidenceIds(
    value.evidenceIds,
    validEvidenceIds,
    `${path}.evidenceIds`,
    value.stance === "uncertain",
  );
  const ballot: PeerBallot = {
    candidateId: value.candidateId,
    stance: value.stance,
    reason: cleanModelText(value.reason),
    evidenceIds: value.evidenceIds,
  };
  if (
    value.suggestedSeverity !== undefined &&
    value.suggestedSeverity !== null
  ) {
    ballot.suggestedSeverity = value.suggestedSeverity;
  }
  return ballot;
}

export function parsePeerOutput(
  input: unknown,
  validEvidenceIds: ReadonlySet<string>,
  validCandidateIds: ReadonlySet<string>,
): PeerOutput {
  const value = parseOutputContract(peerSchema, input, "peer");
  const ballots = value.ballots.map((ballot, index) =>
    parsePeerBallot(ballot, `ballots[${index}]`, validEvidenceIds),
  );
  const seenCandidates = new Set<string>();
  for (const ballot of ballots) {
    if (!validCandidateIds.has(ballot.candidateId)) {
      throw new Error(
        `ballot contains unknown candidate ID: ${ballot.candidateId}`,
      );
    }
    if (seenCandidates.has(ballot.candidateId)) {
      throw new Error(
        `ballot contains duplicate candidate ID: ${ballot.candidateId}`,
      );
    }
    seenCandidates.add(ballot.candidateId);
  }
  if (seenCandidates.size !== validCandidateIds.size) {
    throw new Error(
      `peer output must ballot every candidate (${seenCandidates.size}/${validCandidateIds.size})`,
    );
  }
  const equivalentCandidateGroups = (value.equivalentCandidateGroups ?? []).map(
    (group, index) => {
      if (group.length < 2)
        throw new Error(
          `equivalentCandidateGroups[${index}] must contain at least two candidates`,
        );
      const unique = new Set(group);
      if (unique.size !== group.length)
        throw new Error(
          `equivalentCandidateGroups[${index}] contains a duplicate candidate ID`,
        );
      for (const candidateId of unique)
        if (!validCandidateIds.has(candidateId))
          throw new Error(
            `equivalentCandidateGroups[${index}] contains unknown candidate ID: ${candidateId}`,
          );
      return [...unique].sort();
    },
  );
  return {
    ballots,
    missingFindings: value.missingFindings.map((finding, index) =>
      parseFinding(finding, `missingFindings[${index}]`, validEvidenceIds),
    ),
    equivalentCandidateGroups,
  };
}

export function parseChairOutput(
  input: unknown,
  findings: AggregatedFinding[],
): ChairOutput {
  const value = parseOutputContract(chairSchema, input, "chair");
  const validKeys = new Set(findings.map((finding) => finding.key));
  const classifiedKeys = [
    ...value.consensusFindingKeys,
    ...value.dissentFindingKeys,
  ];
  const uniqueKeys = new Set(classifiedKeys);
  if (uniqueKeys.size !== classifiedKeys.length) {
    throw new Error("chair finding keys must not be duplicated or overlap");
  }
  for (const key of uniqueKeys) {
    if (!validKeys.has(key)) {
      throw new Error(`chair output contains unknown finding key: ${key}`);
    }
  }
  if (uniqueKeys.size !== validKeys.size) {
    throw new Error(
      `chair output must classify every finding (${uniqueKeys.size}/${validKeys.size})`,
    );
  }
  const dissent = new Set(value.dissentFindingKeys);
  for (const finding of findings) {
    if (!finding.consensusEligible && !dissent.has(finding.key)) {
      throw new Error(
        `${finding.resolution} finding must remain in dissent: ${finding.key}`,
      );
    }
  }
  return {
    verdict: value.verdict,
    summary: cleanModelText(value.summary),
    recommendations: value.recommendations.map(cleanModelText),
    consensusFindingKeys: value.consensusFindingKeys,
    dissentFindingKeys: value.dissentFindingKeys,
  };
}
