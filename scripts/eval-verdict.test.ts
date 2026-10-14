import { describe, expect, test } from "bun:test";
import {
  observedExecutor,
  parseEvalVerdictJson,
  verdictBlocksShip,
  verdictForRun,
  verdictReviewProblem,
} from "./eval-verdict";

describe("parseEvalVerdictJson", () => {
  test("accepts minimal valid PASS", () => {
    const r = parseEvalVerdictJson(
      JSON.stringify({
        schemaVersion: 1,
        taskId: "agent-forge-harness-uam",
        verdict: "PASS",
        findings: { blocker: 0, high: 0, medium: 1, low: 0 },
      }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.verdict).toBe("PASS");
  });

  test("FAIL with blocker blocks ship", () => {
    const r = parseEvalVerdictJson(
      JSON.stringify({
        schemaVersion: 1,
        taskId: "x",
        verdict: "FAIL",
        findings: { blocker: 1, high: 0, medium: 0, low: 0 },
      }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(verdictBlocksShip(r.value)).toBe(true);
  });

  test("FAIL with only medium does not block ship", () => {
    const r = parseEvalVerdictJson(
      JSON.stringify({
        schemaVersion: 1,
        taskId: "x",
        verdict: "FAIL",
        findings: { blocker: 0, high: 0, medium: 2, low: 1 },
      }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(verdictBlocksShip(r.value)).toBe(false);
  });

  test("rejects wrong schemaVersion", () => {
    const r = parseEvalVerdictJson(
      JSON.stringify({
        schemaVersion: 3,
        taskId: "x",
        verdict: "PASS",
        findings: { blocker: 0, high: 0, medium: 0, low: 0 },
      }),
    );
    expect(r.ok).toBe(false);
  });

  test("rejects invalid JSON", () => {
    const r = parseEvalVerdictJson("{");
    expect(r.ok).toBe(false);
  });

  test("accepts attestations within 0..5 for known dimensions", () => {
    const r = parseEvalVerdictJson(
      JSON.stringify({
        schemaVersion: 1,
        taskId: "x",
        verdict: "PASS",
        findings: { blocker: 0, high: 0, medium: 0, low: 0 },
        attestations: { quality: 4, reliability: 5, creativity: 3 },
      }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.attestations?.quality).toBe(4);
      expect(r.value.attestations?.reliability).toBe(5);
    }
  });

  test("rejects out-of-range attestation score", () => {
    const r = parseEvalVerdictJson(
      JSON.stringify({
        schemaVersion: 1,
        taskId: "x",
        verdict: "PASS",
        findings: { blocker: 0, high: 0, medium: 0, low: 0 },
        attestations: { quality: 7 },
      }),
    );
    expect(r.ok).toBe(false);
  });

  test("a verdict that contradicts its own counts does not parse, in either schema", () => {
    const legacy = (body: Record<string, unknown>) =>
      JSON.stringify({ schemaVersion: 1, taskId: "x", ...body });
    const cases: Array<[Record<string, unknown>, string]> = [
      [
        {
          verdict: "PASS",
          findings: { blocker: 1, high: 0, medium: 0, low: 0 },
        },
        "a PASS has no blocker or high findings",
      ],
      [
        {
          verdict: "PASS",
          findings: { blocker: 0, high: 2, medium: 1, low: 0 },
        },
        "a PASS has no blocker or high findings",
      ],
      [
        {
          verdict: "FAIL",
          findings: { blocker: 0, high: 0, medium: 0, low: 0 },
        },
        "a FAIL names at least one finding",
      ],
    ];
    for (const [body, error] of cases) {
      expect(parseEvalVerdictJson(legacy(body))).toEqual({ ok: false, error });
      expect(parseEvalVerdictJson(v2(body))).toEqual({ ok: false, error });
    }
    // Medium and low findings go with either verdict.
    for (const verdict of ["PASS", "FAIL"]) {
      expect(
        parseEvalVerdictJson(
          v2({ verdict, findings: { blocker: 0, high: 0, medium: 0, low: 1 } }),
        ).ok,
      ).toBe(true);
    }
  });

  test("the ship check blocks on a blocker or high count whatever the verdict word says", () => {
    expect(
      verdictBlocksShip({
        verdict: "PASS",
        findings: { blocker: 0, high: 1, medium: 0, low: 0 },
      }),
    ).toBe(true);
    expect(
      verdictBlocksShip({
        verdict: "PASS",
        findings: { blocker: 1, high: 0, medium: 0, low: 0 },
      }),
    ).toBe(true);
    expect(
      verdictBlocksShip({
        verdict: "FAIL",
        findings: { blocker: 0, high: 0, medium: 3, low: 0 },
      }),
    ).toBe(false);
  });

  test("rejects unknown attestation dimension", () => {
    const r = parseEvalVerdictJson(
      JSON.stringify({
        schemaVersion: 1,
        taskId: "x",
        verdict: "PASS",
        findings: { blocker: 0, high: 0, medium: 0, low: 0 },
        attestations: { vibes: 5 },
      }),
    );
    expect(r.ok).toBe(false);
  });
});

// ── Schema 2 ────────────────────────────────────────────────────────────────

const MODEL_EVALUATOR = {
  kind: "model",
  requestedProvider: "claude",
  requestedModel: "claude-opus-5-5",
  requestedRank: "master",
  observedProvider: "claude",
  observedModel: "claude-sonnet-5-5",
  providerEvidence: "selected-direct-transport",
  modelEvidence: "response-field",
  rankPolicyDecision: "allowed",
  rankPolicyRule: "evaluator-at-or-above-builder",
} as const;

function v2(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schemaVersion: 2,
    beadsIssueId: "bead-1",
    executionRunId: "run-1",
    verdict: "PASS",
    findings: { blocker: 0, high: 0, medium: 0, low: 0 },
    evaluator: { kind: "human", actorKind: "reviewer" },
    ...overrides,
  });
}

describe("parseEvalVerdictJson, schema 2", () => {
  test("a human verdict carries both ids and an explicit actor kind", () => {
    expect<unknown>(parseEvalVerdictJson(v2())).toEqual({
      ok: true,
      value: {
        schemaVersion: 2,
        beadsIssueId: "bead-1",
        executionRunId: "run-1",
        verdict: "PASS",
        findings: { blocker: 0, high: 0, medium: 0, low: 0 },
        evaluator: { kind: "human", actorKind: "reviewer" },
      },
    });
  });

  test("a model verdict keeps what was requested apart from what was observed", () => {
    const r = parseEvalVerdictJson(
      v2({ evaluator: { ...MODEL_EVALUATOR, sessionId: "session-9" } }),
    );
    expect(r.ok).toBe(true);
    if (r.ok && r.value.schemaVersion === 2) {
      expect(r.value.evaluator).toEqual({
        ...MODEL_EVALUATOR,
        sessionId: "session-9",
      });
      expect(r.value.evaluator).toMatchObject({
        requestedModel: "claude-opus-5-5",
        observedModel: "claude-sonnet-5-5",
      });
    }
  });

  test("a model verdict with nothing observed still parses, with the observed fields absent", () => {
    const {
      observedProvider: _provider,
      observedModel: _model,
      providerEvidence: _providerEvidence,
      modelEvidence: _modelEvidence,
      ...requestedOnly
    } = MODEL_EVALUATOR;
    const r = parseEvalVerdictJson(v2({ evaluator: requestedOnly }));
    expect(r.ok).toBe(true);
    if (r.ok && r.value.schemaVersion === 2) {
      expect(r.value.evaluator).toEqual(requestedOnly);
      expect("observedModel" in r.value.evaluator).toBe(false);
    }
  });

  test("some but not all of the observed fields is not a verdict", () => {
    const { modelEvidence: _modelEvidence, ...partial } = MODEL_EVALUATOR;
    expect(parseEvalVerdictJson(v2({ evaluator: partial }))).toEqual({
      ok: false,
      error:
        "evaluator observedProvider, observedModel, providerEvidence and modelEvidence must all be present or all absent",
    });
  });

  test("missing evaluator identity is refused, whatever else the file says", () => {
    for (const evaluator of [
      undefined,
      null,
      "claude-opus-5-5",
      {},
      { kind: "robot" },
      { kind: "human" },
      { kind: "human", actorKind: "nobody" },
      { ...MODEL_EVALUATOR, requestedRank: "grandmaster" },
      { ...MODEL_EVALUATOR, requestedModel: " " },
      { ...MODEL_EVALUATOR, modelEvidence: "the writer said so" },
      { ...MODEL_EVALUATOR, providerEvidence: "request" },
      { ...MODEL_EVALUATOR, rankPolicyDecision: "maybe" },
      { ...MODEL_EVALUATOR, rankPolicyRule: "" },
      // The rule is a slug, not a sentence someone can put free text in.
      { ...MODEL_EVALUATOR, rankPolicyRule: "because I said so" },
      { ...MODEL_EVALUATOR, rankPolicyRule: "x".repeat(81) },
      // Identity strings are short plain text.
      { ...MODEL_EVALUATOR, requestedModel: "m".repeat(201) },
      { ...MODEL_EVALUATOR, observedModel: "claude\nopus" },
      { ...MODEL_EVALUATOR, observedProvider: "p".repeat(201) },
      { ...MODEL_EVALUATOR, sessionId: "s".repeat(201) },
      { ...MODEL_EVALUATOR, sessionId: "tab\there" },
    ]) {
      const r = parseEvalVerdictJson(v2({ evaluator }));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toStartWith("evaluator");
    }
  });

  test("both ids are required and must be a Beads id and a Forge run id", () => {
    for (const overrides of [
      { beadsIssueId: undefined },
      { beadsIssueId: "" },
      { beadsIssueId: "--help" },
      { executionRunId: undefined },
      { executionRunId: "" },
      { executionRunId: "../run-1" },
    ]) {
      expect(parseEvalVerdictJson(v2(overrides)).ok).toBe(false);
    }
  });

  test("a schema 1 file is still read, as a legacy verdict with no run and no evaluator", () => {
    const r = parseEvalVerdictJson(
      JSON.stringify({
        schemaVersion: 1,
        taskId: "bead-1",
        verdict: "PASS",
        findings: { blocker: 0, high: 0, medium: 0, low: 0 },
        // Not part of schema 1: never read from a legacy file.
        evaluator: { kind: "human", actorKind: "operator" },
        executionRunId: "run-1",
      }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.schemaVersion).toBe(1);
      expect("evaluator" in r.value).toBe(false);
      expect("executionRunId" in r.value).toBe(false);
    }
  });

  test("a verdict may name the review round it was written for, as <phase>-<round>, and nothing else", () => {
    for (const review of ["research-1", "plan-2", "implement-10", "ship-1"]) {
      const r = parseEvalVerdictJson(v2({ review }));
      expect(r.ok && r.value.schemaVersion === 2 && r.value.review).toBe(
        review,
      );
    }
    for (const review of [
      "",
      "plan",
      "plan-0",
      "plan-01",
      "Plan-1",
      "impl-1",
      "deploy-1",
      "plan-1a",
      "plan-1234567890",
      7,
      null,
    ]) {
      expect(parseEvalVerdictJson(v2({ review }))).toEqual({
        ok: false,
        error:
          "review must be a review round, <phase>-<round>: phase research, plan, implement or ship, and round a positive integer",
      });
    }
    // A verdict that names no round has no review field at all.
    const plain = parseEvalVerdictJson(v2());
    expect(plain.ok && "review" in plain.value).toBe(false);
  });

  test("any other schema version is refused", () => {
    expect(parseEvalVerdictJson(v2({ schemaVersion: 3 }))).toEqual({
      ok: false,
      error: "schemaVersion must be 2 (or 1, legacy)",
    });
  });
});

describe("verdictForRun", () => {
  const RUN = { beadsIssueId: "bead-1", executionRunId: "run-1" };

  function parsed(text: string) {
    const r = parseEvalVerdictJson(text);
    if (!r.ok) throw new Error(r.error);
    return r.value;
  }

  test("a schema 2 verdict naming the bead and the run is that run's verdict", () => {
    expect(verdictForRun(parsed(v2()), RUN).ok).toBe(true);
  });

  test("a verdict for another run of the same bead is refused", () => {
    expect(verdictForRun(parsed(v2({ executionRunId: "run-0" })), RUN)).toEqual(
      {
        ok: false,
        error: 'verdict executionRunId "run-0" is not this run ("run-1")',
      },
    );
  });

  test("a verdict for another bead is refused", () => {
    expect(verdictForRun(parsed(v2({ beadsIssueId: "bead-9" })), RUN)).toEqual({
      ok: false,
      error: 'verdict beadsIssueId "bead-9" is not this run\'s bead ("bead-1")',
    });
  });

  test("a run that names no bead is matched on the run id alone", () => {
    expect(
      verdictForRun(parsed(v2({ beadsIssueId: "bead-9" })), {
        executionRunId: "run-1",
      }).ok,
    ).toBe(true);
  });

  test("a legacy verdict is never a run's verdict, even filed under the right bead", () => {
    const legacy = parsed(
      JSON.stringify({
        schemaVersion: 1,
        taskId: "bead-1",
        verdict: "PASS",
        findings: { blocker: 0, high: 0, medium: 0, low: 0 },
      }),
    );
    expect(verdictForRun(legacy, RUN)).toEqual({
      ok: false,
      error:
        "the verdict is schema 1 (legacy): it names no run and no evaluator",
    });
  });
});

describe("verdictReviewProblem", () => {
  function parsed(text: string) {
    const r = parseEvalVerdictJson(text);
    if (!r.ok || r.value.schemaVersion !== 2) throw new Error("not schema 2");
    return r.value;
  }

  test("the run's verdict names no review round", () => {
    expect(verdictReviewProblem(parsed(v2()), null)).toBeNull();
    expect(verdictReviewProblem(parsed(v2({ review: "plan-1" })), null)).toBe(
      "the verdict names review round \"plan-1\": a round's verdict is not the run's verdict",
    );
  });

  test("a round's verdict names that round: not another, and not none", () => {
    expect(
      verdictReviewProblem(parsed(v2({ review: "plan-2" })), "plan-2"),
    ).toBeNull();
    expect(
      verdictReviewProblem(parsed(v2({ review: "plan-1" })), "plan-2"),
    ).toBe(
      'the verdict names review round "plan-1", not this file\'s round ("plan-2")',
    );
    expect(verdictReviewProblem(parsed(v2()), "plan-2")).toBe(
      'the verdict names no review round, and this file is round "plan-2"\'s',
    );
  });
});

describe("observedExecutor", () => {
  test("is the observed provider and model, never the requested ones", () => {
    expect(
      observedExecutor({
        ...MODEL_EVALUATOR,
        observedModel: "claude-haiku-4-5-20251001",
        rankPolicyDecision: "rejected",
        sessionId: "session-9",
      }),
    ).toEqual({
      provider: "claude",
      model: "claude-haiku-4-5-20251001",
      sessionId: "session-9",
    });
  });

  test("is absent for a human and for a model that was not observed", () => {
    expect(
      observedExecutor({ kind: "human", actorKind: "operator" }),
    ).toBeUndefined();
    expect(
      observedExecutor({
        kind: "model",
        requestedProvider: "claude",
        requestedModel: "claude-opus-5-5",
        requestedRank: "master",
        rankPolicyDecision: "rejected",
        rankPolicyRule: "evaluator-rank-unknown",
      }),
    ).toBeUndefined();
  });
});
