import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { buildContextPack } from "./context";
import { FakeCouncilTransport, runCouncil } from "./engine";
import {
  type ChairOutput,
  type CouncilProfile,
  estimateCouncilCost,
  type IndependentOutput,
  type ModelRequest,
  ModelTransportError,
  type PeerOutput,
  type ProposedFinding,
  parseCouncilProfileJson,
} from "./types";

function profile(overrides: Partial<CouncilProfile> = {}): CouncilProfile {
  const seat = {
    role: "Reviewer",
    provider: "fake",
    model: "test",
    timeoutMs: 1000,
    maxOutputTokens: 1000,
    estimatedCostUsd: 0.01,
  };
  return {
    schemaVersion: 1,
    id: "protocol-test",
    title: "Protocol scenarios",
    depth: "balanced",
    minQuorum: 3,
    minPeerBallots: 2,
    maxEstimatedUsd: 1,
    seats: ["alpha", "beta", "gamma", "delta"].map((id) => ({ ...seat, id })),
    chair: { ...seat, id: "chair", estimatedCostUsd: 0.02 },
    ...overrides,
  };
}

const evidence = () =>
  buildContextPack({
    kind: "stdin",
    text: "GUARD_EVIDENCE: authorization is enforced by the guard at line 42.",
  });
const finding = (
  overrides: Partial<ProposedFinding> = {},
): ProposedFinding => ({
  localId: "F1",
  title: "Authorization guard is missing",
  severity: "high",
  claim: "The operation has no authorization guard.",
  consequence: "Unauthorized access is possible.",
  evidenceIds: ["E1"],
  confidence: 0.8,
  ...overrides,
});
const independent = (findings: ProposedFinding[] = []): IndependentOutput => ({
  verdict: findings.length ? "needs_changes" : "pass",
  findings,
  strengths: [],
  unknowns: [],
});
function passChair(request: ModelRequest): ChairOutput {
  return {
    verdict: "pass",
    summary: "The final evidence has been considered.",
    recommendations: [],
    consensusFindingKeys: (request.aggregatedFindings ?? [])
      .filter((f) => f.consensusEligible)
      .map((f) => f.key),
    dissentFindingKeys: (request.aggregatedFindings ?? [])
      .filter((f) => !f.consensusEligible)
      .map((f) => f.key),
  };
}
function ballots(
  request: ModelRequest,
  stance: "support" | "oppose" | "uncertain",
  reason: string,
  suggestedSeverity?: ProposedFinding["severity"],
): PeerOutput {
  return {
    ballots: (request.candidates ?? []).map((candidate) => ({
      candidateId: candidate.candidateId,
      stance,
      reason,
      evidenceIds: ["E1"],
      ...(suggestedSeverity ? { suggestedSeverity } : {}),
    })),
    missingFindings: [],
    equivalentCandidateGroups: [],
  };
}

describe("deliberation quality regressions", () => {
  test("a unanimous uncertain review cannot become a pass and reaches the chair with its evidence", async () => {
    const transport = new FakeCouncilTransport({
      output: (request) =>
        request.stage === "independent"
          ? {
              ...independent(),
              verdict: "uncertain",
              strengths: ["The assumptions are explicit."],
              unknowns: ["REQUIRED_APPENDIX is unavailable."],
            }
          : request.stage === "chair"
            ? passChair(request)
            : undefined,
    });
    const result = await runCouncil({
      profile: profile(),
      context: evidence(),
      resolveTransport: () => transport,
    });
    expect(result.ok).toBe(true);
    expect(result.run.chair?.verdict).toBe("insufficient_evidence");
    const prompt = transport.requests.find((r) => r.stage === "chair")!.prompt;
    expect(prompt).toContain("REQUIRED_APPENDIX");
    expect(prompt).toContain("The assumptions are explicit.");
    expect(prompt).toContain("GUARD_EVIDENCE");
    expect(result.run.limitations).toContain(
      "REQUIRED_APPENDIX is unavailable.",
    );
  });

  test("reported unknowns remain visible without vetoing a quorate pass", async () => {
    const transport = new FakeCouncilTransport({
      output: (request) =>
        request.stage === "independent"
          ? {
              ...independent(),
              unknowns:
                request.seat.id === "alpha"
                  ? ["A nonessential appendix was not supplied."]
                  : [],
            }
          : request.stage === "chair"
            ? passChair(request)
            : undefined,
    });
    const result = await runCouncil({
      profile: profile(),
      context: evidence(),
      resolveTransport: () => transport,
    });
    expect(result.run.chair?.verdict).toBe("pass");
    expect(result.run.limitations).toContain(
      "A nonessential appendix was not supplied.",
    );
  });

  test("peer-confirmed paraphrases merge without inflating votes", async () => {
    const transport = new FakeCouncilTransport({
      output: (request) => {
        if (request.stage === "independent")
          return independent([
            finding({
              localId: request.seat.id,
              title: `Authorization concern ${request.seat.id}`,
              claim: `Reviewer wording ${request.seat.id}: the privileged operation lacks authorization.`,
              consequence: `Variant ${request.seat.id}: unauthorized access can result.`,
              severity: "low",
            }),
          ]);
        if (request.stage === "peer") {
          const output = ballots(
            request,
            "support",
            "The evidence supports it.",
          );
          return {
            ...output,
            equivalentCandidateGroups: [
              (request.candidates ?? []).map(
                (candidate) => candidate.candidateId,
              ),
            ],
          };
        }
        return request.stage === "chair" ? passChair(request) : undefined;
      },
    });
    const result = await runCouncil({
      profile: profile(),
      context: evidence(),
      resolveTransport: () => transport,
    });
    expect(result.run.aggregatedFindings).toHaveLength(1);
    expect(result.run.aggregatedFindings[0]?.independentProposers).toBe(4);
    expect(result.run.aggregatedFindings[0]?.support).toBe(0);
  });

  test("one peer cannot collapse merely related findings", async () => {
    const transport = new FakeCouncilTransport({
      output: (request) => {
        if (request.stage === "independent")
          return independent([
            finding({
              localId: request.seat.id,
              title: `Distinct concern ${request.seat.id}`,
              claim: `A distinct failure mode is described by ${request.seat.id}.`,
            }),
          ]);
        if (request.stage === "peer") {
          const output = ballots(
            request,
            "support",
            "Independently supported.",
          );
          return {
            ...output,
            equivalentCandidateGroups:
              request.seat.id === "alpha"
                ? [
                    (request.candidates ?? []).map(
                      (candidate) => candidate.candidateId,
                    ),
                  ]
                : [],
          };
        }
        return request.stage === "chair" ? passChair(request) : undefined;
      },
    });
    const result = await runCouncil({
      profile: profile(),
      context: evidence(),
      resolveTransport: () => transport,
    });
    expect(result.run.aggregatedFindings).toHaveLength(4);
  });

  test("domain facts survive anonymization and authors cannot ballot their own findings", async () => {
    const roster = profile();
    roster.seats[0]!.provider = "openai";
    roster.seats[1]!.provider = "anthropic";
    roster.seats[2]!.id = "security";
    const transport = new FakeCouncilTransport({
      output: (request) =>
        request.stage === "independent"
          ? independent(
              request.seat.id === "alpha"
                ? [
                    finding({
                      title: "OpenAI key sent to Anthropic",
                      claim:
                        "The OpenAI key crosses the Anthropic security boundary.",
                    }),
                  ]
                : [],
            )
          : undefined,
    });
    await runCouncil({
      profile: roster,
      context: evidence(),
      resolveTransport: () => transport,
    });
    const authorsPeer = transport.requests.find(
      (r) => r.stage === "peer" && r.seat.id === "alpha",
    )!;
    expect(authorsPeer.candidates).toHaveLength(0);
    const externalPeer = transport.requests.find(
      (r) => r.stage === "peer" && r.seat.id === "beta",
    )!;
    expect(externalPeer.candidates?.[0]?.finding.claim).toBe(
      "The OpenAI key crosses the Anthropic security boundary.",
    );
  });

  test("reviewer labels remain tied to roster seats after a failure", async () => {
    const transport = new FakeCouncilTransport({
      fail: [{ stage: "independent", seatId: "alpha" }],
      output: (request) =>
        request.stage === "independent"
          ? { ...independent(), strengths: [`marker-${request.seat.id}`] }
          : request.stage === "chair"
            ? passChair(request)
            : undefined,
    });
    await runCouncil({
      profile: profile(),
      context: evidence(),
      resolveTransport: () => transport,
    });
    const prompt = transport.requests.find(
      (request) => request.stage === "chair",
    )!.prompt;
    expect(prompt).toContain(
      '\"reviewerLabel\":\"Reviewer 2\",\"verdict\":\"pass\",\"strengths\":[\"marker-beta\"]',
    );
  });

  test("late findings are unreviewed in balanced mode and gain independent ballots in deep mode", async () => {
    for (const depth of ["balanced", "deep"] as const) {
      const transport = new FakeCouncilTransport({
        output: (request) =>
          request.stage === "independent"
            ? independent()
            : request.stage === "peer"
              ? {
                  ballots: [],
                  missingFindings:
                    request.seat.id === "alpha"
                      ? [finding({ severity: "blocker" })]
                      : [],
                }
              : undefined,
      });
      const result = await runCouncil({
        profile: profile({ depth }),
        context: evidence(),
        resolveTransport: () => transport,
      });
      expect(result.ok).toBe(true);
      const aggregate = result.run.aggregatedFindings[0]!;
      expect(aggregate.support).toBe(depth === "deep" ? 3 : 0);
      expect(aggregate.resolution).toBe(
        depth === "deep" ? "consensus" : "unreviewed",
      );
      expect(
        result.run.chair?.consensusFindingKeys.includes(aggregate.key),
      ).toBe(depth === "deep");
    }
  });

  test("a chair cannot label an unreviewed late blocker as consensus", async () => {
    const transport = new FakeCouncilTransport({
      output: (request) =>
        request.stage === "independent"
          ? independent()
          : request.stage === "peer"
            ? {
                ballots: [],
                missingFindings: request.seat.id === "alpha" ? [finding()] : [],
              }
            : {
                ...passChair(request),
                consensusFindingKeys: request.aggregatedFindings?.map(
                  (f) => f.key,
                ),
                dissentFindingKeys: [],
              },
    });
    const result = await runCouncil({
      profile: profile(),
      context: evidence(),
      resolveTransport: () => transport,
    });
    expect(result.ok).toBe(false);
    expect(result.run.failures.at(-1)?.error).toContain(
      "unreviewed finding must remain in dissent",
    );
  });

  test("an unresolved low-severity note is reported without vetoing a pass", async () => {
    const transport = new FakeCouncilTransport({
      output: (request) =>
        request.stage === "independent"
          ? independent()
          : request.stage === "peer"
            ? {
                ballots: [],
                missingFindings:
                  request.seat.id === "alpha"
                    ? [finding({ severity: "low", title: "Minor wording" })]
                    : [],
              }
            : request.stage === "chair"
              ? passChair(request)
              : undefined,
    });
    const result = await runCouncil({
      profile: profile(),
      context: evidence(),
      resolveTransport: () => transport,
    });
    expect(result.ok).toBe(true);
    expect(result.run.aggregatedFindings[0]?.resolution).toBe("unreviewed");
    expect(result.run.chair?.verdict).toBe("pass");
    expect(result.run.limitations.join(" ")).toContain("Minor wording");
  });

  test("parallel revisions consume rebuttals, change judgments, and do not multiply votes", async () => {
    const transport = new FakeCouncilTransport({
      delayMs: 5,
      output: (request) => {
        if (request.stage === "independent")
          return independent(request.seat.id === "alpha" ? [finding()] : []);
        if (request.stage === "peer")
          return ballots(
            request,
            request.seat.id === "gamma" ? "oppose" : "support",
            request.seat.id === "gamma"
              ? "REBUTTAL: the authorization guard is present at line 42."
              : "Initially the claim appears plausible.",
          );
        if (request.stage === "revision") {
          expect(request.prompt).toContain(
            "REBUTTAL: the authorization guard is present at line 42.",
          );
          return ballots(
            request,
            "oppose",
            "The guard at line 42 disproves the original claim; I revise my judgment after the rebuttal.",
          );
        }
        return passChair(request);
      },
    });
    const result = await runCouncil({
      profile: profile({ depth: "deep", maxDiscussionRounds: 1 }),
      context: evidence(),
      resolveTransport: () => transport,
    });
    expect(result.ok).toBe(true);
    expect(transport.maxActive).toBe(4);
    const aggregate = result.run.aggregatedFindings[0]!;
    expect(aggregate.support).toBe(0);
    expect(aggregate.oppose).toBe(3);
    expect(aggregate.resolution).toBe("rejected");
    expect(result.run.chair?.verdict).toBe("pass");
    expect(
      transport.requests.find((r) => r.stage === "chair")!.prompt,
    ).toContain("I revise my judgment after the rebuttal.");
    const revisionStart = result.run.events.find(
      (e) => e.type === "stage.started" && e.payload.stage === "revision",
    )!.seq;
    expect(
      result.run.events
        .filter(
          (e) => e.type === "seat.completed" && e.payload.stage === "peer",
        )
        .every((e) => e.seq < revisionStart),
    ).toBe(true);
    expect(
      result.run.records.filter((r) => r.stage === "revision"),
    ).toHaveLength(4);
  });

  test("unanimous external severity corrections can downgrade a finding", async () => {
    const transport = new FakeCouncilTransport({
      output: (request) =>
        request.stage === "independent"
          ? independent(
              request.seat.id === "alpha"
                ? [finding({ title: "Comment typo", severity: "blocker" })]
                : [],
            )
          : request.stage === "peer"
            ? ballots(
                request,
                "support",
                "The typo exists but has only a small readability cost.",
                "low",
              )
            : undefined,
    });
    const result = await runCouncil({
      profile: profile(),
      context: evidence(),
      resolveTransport: () => transport,
    });
    expect(result.run.aggregatedFindings[0]?.severity).toBe("low");
    expect(result.run.aggregatedFindings[0]?.consensusEligible).toBe(true);
  });

  test("reduced participation and unresolved critical findings never receive pass", async () => {
    const reduced = new FakeCouncilTransport({
      fail: [{ stage: "independent", seatId: "delta" }],
      output: (request) =>
        request.stage === "independent"
          ? independent()
          : request.stage === "chair"
            ? passChair(request)
            : undefined,
    });
    const reducedResult = await runCouncil({
      profile: profile(),
      context: evidence(),
      resolveTransport: () => reduced,
    });
    expect(reducedResult.run.chair?.verdict).toBe("insufficient_evidence");
    const critical = new FakeCouncilTransport({
      output: (request) =>
        request.stage === "independent"
          ? independent(request.seat.id === "alpha" ? [finding()] : [])
          : request.stage === "chair"
            ? passChair(request)
            : undefined,
    });
    const criticalResult = await runCouncil({
      profile: profile(),
      context: evidence(),
      resolveTransport: () => critical,
    });
    expect(criticalResult.run.chair?.verdict).toBe("needs_changes");
  });

  test("deep discussion is bounded and included in the estimate", () => {
    expect(
      estimateCouncilCost(profile({ depth: "deep", maxDiscussionRounds: 2 })),
    ).toBe(0.18);
    expect(
      parseCouncilProfileJson(
        JSON.stringify(profile({ depth: "deep", maxDiscussionRounds: 4 })),
      ).ok,
    ).toBe(false);
    expect(
      parseCouncilProfileJson(
        JSON.stringify(profile({ depth: "balanced", maxDiscussionRounds: 1 })),
      ).ok,
    ).toBe(false);
  });

  test("severity disagreement and evidence-free support cannot manufacture consensus", async () => {
    const disagreeing = new FakeCouncilTransport({
      output: (request) =>
        request.stage === "independent"
          ? independent([
              finding({
                severity: request.seat.id === "alpha" ? "blocker" : "low",
              }),
            ])
          : request.stage === "chair"
            ? passChair(request)
            : undefined,
    });
    const result = await runCouncil({
      profile: profile(),
      context: evidence(),
      resolveTransport: () => disagreeing,
    });
    expect(result.run.aggregatedFindings[0]?.severityDisputed).toBe(true);
    expect(result.run.aggregatedFindings[0]?.consensusEligible).toBe(false);
    expect(result.run.chair?.verdict).toBe("insufficient_evidence");
    const unsupported = new FakeCouncilTransport({
      output: (request) =>
        request.stage === "independent"
          ? independent(request.seat.id === "alpha" ? [finding()] : [])
          : request.stage === "peer"
            ? {
                ballots: (request.candidates ?? []).map((candidate) => ({
                  candidateId: candidate.candidateId,
                  stance: "support",
                  reason: "I agree without supplied evidence.",
                  evidenceIds: [],
                })),
                missingFindings: [],
              }
            : undefined,
    });
    const unsupportedResult = await runCouncil({
      profile: profile(),
      context: evidence(),
      resolveTransport: () => unsupported,
    });
    expect(unsupportedResult.ok).toBe(false);
    expect(
      unsupportedResult.run.failures.some((failure) =>
        failure.error.includes("must cite at least one evidence ID"),
      ),
    ).toBe(true);
  });
});

describe("conservative accounting", () => {
  test("checked-in paid profiles can finish at the advertised context limit", async () => {
    for (const path of [
      "councils/openrouter.example.json",
      "councils/multi-provider.example.json",
    ]) {
      const parsed = parseCouncilProfileJson(readFileSync(path, "utf8"));
      if (!parsed.ok) throw new Error(parsed.error);
      const transport = new FakeCouncilTransport();
      const result = await runCouncil({
        profile: parsed.value,
        context: buildContextPack({
          kind: "stdin",
          text: "x".repeat(200_000),
        }),
        resolveTransport: () => transport,
      });
      expect(result.ok).toBe(true);
      expect(transport.requests).toHaveLength(13);
    }
  });
  test("malformed paid output retains usage and cannot finance another round with an unknown zero", async () => {
    const fake = new FakeCouncilTransport();
    const transport = {
      generate: async (request: ModelRequest, signal: AbortSignal) => {
        if (request.seat.id === "alpha")
          throw new ModelTransportError("Malformed model output", {
            usage: { inputTokens: 300, outputTokens: 100 },
            estimatedUsageCostUsd: 0.08,
          });
        const result = await fake.generate(request, signal);
        return {
          output: result.output,
          usage: { inputTokens: 100, outputTokens: 20 },
          estimatedUsageCostUsd: 0.01,
        };
      },
    };
    const result = await runCouncil({
      profile: profile(),
      context: evidence(),
      resolveTransport: () => transport,
      maxUsd: 0.12,
    });
    expect(result.ok).toBe(false);
    expect(result.run.error).toContain("remaining budget");
    expect(result.run.actualCostUsd).toBeNull();
    expect(result.run.accountedCostUsd).toBe(0.11);
    expect(result.run.usageEstimatedCostUsd).toBe(0.11);
    expect(result.run.records[0]?.usage?.inputTokens).toBe(300);
    expect(
      result.run.records.every((record) => record.stage === "independent"),
    ).toBe(true);
  });

  test("known token rates reserve a large input before any provider is called", async () => {
    const roster = profile();
    roster.seats = roster.seats.map((seat) => ({
      ...seat,
      tokenRatesUsdPerMillion: { input: 100, output: 100 },
    }));
    const transport = new FakeCouncilTransport();
    const result = await runCouncil({
      profile: roster,
      context: evidence(),
      resolveTransport: () => transport,
      maxUsd: 0.2,
    });
    expect(result.ok).toBe(false);
    expect(result.run.error).toContain("estimated token cost");
    expect(transport.requests).toHaveLength(0);
  });
});
