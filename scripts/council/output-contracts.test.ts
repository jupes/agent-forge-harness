import { describe, expect, test } from "bun:test";
import { hashText } from "./context";
import { outputSchema } from "./output-contracts";
import {
  parseChairOutput,
  parseIndependentOutput,
  parsePeerOutput,
} from "./output-validation";
import type { IndependentOutput, PeerBallot, ProposedFinding } from "./types";

const evidence = new Set(["E1"]);
const candidate = new Set(["C1"]);
const finding: ProposedFinding = {
  localId: "F1",
  title: "A finding",
  severity: "high",
  claim: "A claim",
  consequence: "An impact",
  evidenceIds: ["E1"],
  confidence: 0.5,
};
const review: IndependentOutput = {
  verdict: "needs_changes",
  findings: [finding],
  strengths: [],
  unknowns: [],
};
const ballot: PeerBallot = {
  candidateId: "C1",
  stance: "support",
  reason: "Supported",
  evidenceIds: ["E1"],
};

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => [key, canonical(entry)]),
    );
  return value;
}

describe("shared output contracts", () => {
  // These fingerprints were captured from the pre-refactor provider schemas
  // (59b2111). A deliberate wire change must update this compatibility check.
  for (const [stage, fingerprint] of [
    [
      "independent",
      "70506255030f7625e3c8176cf58d1f3dc61ef11ed1d4c491879630ae869cbf16",
    ],
    [
      "peer",
      "d7166f474c8f797df014a70af0b455a432e48b2eabfe7d352f4575a3dda63ee3",
    ],
    [
      "revision",
      "d7166f474c8f797df014a70af0b455a432e48b2eabfe7d352f4575a3dda63ee3",
    ],
    [
      "chair",
      "02f19bb299ba70fea3d0830431d18f825b088594fc2f5b1f7f2fface64663618",
    ],
  ] as const) {
    test(`${stage} preserves the provider wire contract`, () => {
      expect(hashText(JSON.stringify(canonical(outputSchema(stage))))).toBe(
        fingerprint,
      );
    });
  }

  test("provider schema callers cannot mutate later requests", () => {
    const schema = outputSchema("peer");
    (schema.properties as Record<string, unknown>).ballots = {};
    expect(outputSchema("peer")).toEqual(outputSchema("revision"));
    expect(outputSchema("peer")).not.toEqual(schema);
  });

  test("normalizes model text and strips extra fields without mutating the input", () => {
    const input = {
      ...review,
      findings: [{ ...finding, title: "  A finding  ", extra: true }],
      extra: true,
    };
    const parsed = parseIndependentOutput(input, evidence);
    expect(parsed).toEqual(review);
    expect(input.findings[0]?.title).toBe("  A finding  ");
  });

  for (const patch of [
    { title: "  " },
    { localId: "" },
    { severity: "urgent" },
    { claim: null },
    { confidence: -0.1 },
    { confidence: 1.1 },
    { confidence: NaN },
    { confidence: Infinity },
    { evidenceIds: [] },
    { evidenceIds: ["E404"] },
    { evidenceIds: [42] },
  ]) {
    test(`rejects an invalid finding: ${Object.keys(patch)[0]} ${String(Object.values(patch)[0])}`, () => {
      expect(() =>
        parseIndependentOutput(
          { ...review, findings: [{ ...finding, ...patch }] },
          evidence,
        ),
      ).toThrow();
    });
  }

  test("accepts omitted and null severity suggestions but normalizes both to absence", () => {
    for (const suggestion of [{}, { suggestedSeverity: null }]) {
      expect(
        parsePeerOutput(
          { ballots: [{ ...ballot, ...suggestion }], missingFindings: [] },
          evidence,
          candidate,
        ).ballots,
      ).toEqual([ballot]);
    }
    expect(
      parsePeerOutput(
        {
          ballots: [{ ...ballot, suggestedSeverity: "low" }],
          missingFindings: [],
        },
        evidence,
        candidate,
      ).ballots[0]?.suggestedSeverity,
    ).toBe("low");
  });

  test("only an uncertain ballot may omit evidence", () => {
    const input = {
      ballots: [{ ...ballot, evidenceIds: [] }],
      missingFindings: [],
    };
    expect(() => parsePeerOutput(input, evidence, candidate)).toThrow(
      "must cite",
    );
    expect(
      parsePeerOutput(
        { ...input, ballots: [{ ...input.ballots[0], stance: "uncertain" }] },
        evidence,
        candidate,
      ).ballots[0]?.stance,
    ).toBe("uncertain");
  });

  test("keeps contextual candidate and chair checks beyond the shared shape", () => {
    expect(() =>
      parsePeerOutput(
        { ballots: [], missingFindings: [] },
        evidence,
        candidate,
      ),
    ).toThrow("every candidate");
    expect(() =>
      parseChairOutput(
        {
          verdict: "pass",
          summary: "Done",
          recommendations: [],
          consensusFindingKeys: ["invented"],
          dissentFindingKeys: [],
        },
        [],
      ),
    ).toThrow("unknown finding key");
  });
});
