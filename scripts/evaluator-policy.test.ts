import { describe, expect, test } from "bun:test";
import type { EvaluatorIdentity, Smith } from "../types/hearth";
import { BUILTIN_SMITHS } from "./config/defaults";
import { rankOf, rankPolicy, strictEvaluatorProblem } from "./evaluator-policy";

const SMITHS = Object.values(BUILTIN_SMITHS);

const OPUS = { provider: "claude", model: "claude-opus-5-5" };
const SONNET = { provider: "claude", model: "claude-sonnet-5-5" };
const HAIKU = { provider: "claude", model: "claude-haiku-4-5-20251001" };

function smith(
  name: string,
  model: string,
  tags: string[],
  provider = "claude",
): Smith {
  return { name, provider, model, effort: "medium", enabled: true, tags };
}

describe("rankOf", () => {
  test("is the rank tag of the configured smith with that provider and model", () => {
    expect(rankOf(SMITHS, OPUS, "lowest")).toBe("master");
    expect(rankOf(SMITHS, SONNET, "lowest")).toBe("journeyman");
    expect(rankOf(SMITHS, HAIKU, "lowest")).toBe("apprentice");
  });

  test("is unknown for a model no smith is configured with, and for a smith with no rank tag", () => {
    expect(
      rankOf(SMITHS, { provider: "claude", model: "claude-next" }, "lowest"),
    ).toBeNull();
    // The same model name under another provider is another executor.
    expect(
      rankOf(SMITHS, { provider: "codex", model: "claude-opus-5-5" }, "lowest"),
    ).toBeNull();
    const m1 = { provider: "claude", model: "m-1" };
    expect(
      rankOf([smith("untagged", "m-1", ["fast"])], m1, "lowest"),
    ).toBeNull();
    expect(
      rankOf([smith("typo", "m-1", ["rank:grandmaster"])], m1, "lowest"),
    ).toBeNull();
  });

  test("when smiths of different ranks share a model, the caller says which end to take", () => {
    const shared = [
      smith("opus-quick", "claude-opus-5-5", ["rank:journeyman"]),
      smith("opus-deep", "claude-opus-5-5", ["rank:master"]),
    ];
    expect(rankOf(shared, OPUS, "lowest")).toBe("journeyman");
    expect(rankOf(shared, OPUS, "highest")).toBe("master");
  });

  test("an executor that names its smith takes that smith's rank, when the smith is that provider and model", () => {
    const shared = [
      smith("opus-quick", "claude-opus-5-5", ["rank:journeyman"]),
      smith("opus-deep", "claude-opus-5-5", ["rank:master"]),
    ];
    expect(rankOf(shared, { ...OPUS, smith: "opus-quick" }, "highest")).toBe(
      "journeyman",
    );
    // A smith name that does not describe the executor is ignored.
    expect(rankOf(shared, { ...SONNET, smith: "opus-deep" }, "highest")).toBe(
      null,
    );
  });
});

describe("rankOf, a smith with more than one rank tag", () => {
  test("takes the end the caller asked for, whatever the order of the tags", () => {
    for (const tags of [
      ["rank:master", "rank:apprentice"],
      ["rank:apprentice", "rank:master"],
    ]) {
      const both = [smith("both", "claude-opus-5-5", tags)];
      expect(rankOf(both, OPUS, "lowest")).toBe("apprentice");
      expect(rankOf(both, OPUS, "highest")).toBe("master");
      expect(rankOf(both, { ...OPUS, smith: "both" }, "lowest")).toBe(
        "apprentice",
      );
    }
  });
});

describe("rankPolicy", () => {
  test("an evaluator at or above the builder's rank is allowed", () => {
    for (const [evaluator, builder] of [
      ["master", "master"],
      ["master", "journeyman"],
      ["master", "apprentice"],
      ["journeyman", "journeyman"],
      ["journeyman", "apprentice"],
      ["apprentice", "apprentice"],
    ] as const) {
      expect(rankPolicy({ evaluator, builder })).toEqual({
        decision: "allowed",
        rule: "evaluator-at-or-above-builder",
      });
    }
  });

  test("an evaluator below the builder's rank is rejected", () => {
    for (const [evaluator, builder] of [
      ["journeyman", "master"],
      ["apprentice", "master"],
      ["apprentice", "journeyman"],
    ] as const) {
      expect(rankPolicy({ evaluator, builder })).toEqual({
        decision: "rejected",
        rule: "evaluator-below-builder",
      });
    }
  });

  test("an evaluator whose rank is not known is rejected, whoever built the work", () => {
    expect(rankPolicy({ evaluator: null, builder: "apprentice" })).toEqual({
      decision: "rejected",
      rule: "evaluator-rank-unknown",
    });
    expect(rankPolicy({ evaluator: null, builder: null })).toEqual({
      decision: "rejected",
      rule: "evaluator-rank-unknown",
    });
  });

  test("with the builder's rank unknown only a master evaluator is allowed", () => {
    expect(rankPolicy({ evaluator: "master", builder: null })).toEqual({
      decision: "allowed",
      rule: "master-evaluator-builder-unknown",
    });
    for (const evaluator of ["journeyman", "apprentice"] as const) {
      expect(rankPolicy({ evaluator, builder: null })).toEqual({
        decision: "rejected",
        rule: "builder-rank-unknown",
      });
    }
  });
});

function model(
  overrides: Partial<Extract<EvaluatorIdentity, { kind: "model" }>> = {},
): EvaluatorIdentity {
  return {
    kind: "model",
    requestedProvider: "claude",
    requestedModel: "claude-opus-5-5",
    requestedRank: "master",
    observedProvider: "claude",
    observedModel: "claude-opus-5-5",
    providerEvidence: "selected-direct-transport",
    modelEvidence: "response-field",
    rankPolicyDecision: "allowed",
    rankPolicyRule: "evaluator-at-or-above-builder",
    ...overrides,
  };
}

describe("strictEvaluatorProblem", () => {
  test("a human evaluator satisfies strict completion with its actor kind alone", () => {
    expect(
      strictEvaluatorProblem(
        { kind: "human", actorKind: "operator" },
        { smiths: SMITHS, builder: OPUS },
      ),
    ).toBeNull();
  });

  test("an observed evaluator at or above the builder's rank satisfies it", () => {
    expect(
      strictEvaluatorProblem(model(), { smiths: SMITHS, builder: SONNET }),
    ).toBeNull();
    expect(
      strictEvaluatorProblem(model(), { smiths: SMITHS, builder: OPUS }),
    ).toBeNull();
  });

  test("a model evaluator with nothing observed fails, however strong the request", () => {
    const {
      observedProvider: _provider,
      observedModel: _model,
      providerEvidence: _providerEvidence,
      modelEvidence: _modelEvidence,
      ...requestedOnly
    } = model() as Extract<EvaluatorIdentity, { kind: "model" }>;
    expect(
      strictEvaluatorProblem(requestedOnly, {
        smiths: SMITHS,
        builder: HAIKU,
      }),
    ).toBe(
      "the verdict records no observed evaluator provider and model (requested claude/claude-opus-5-5 is not evidence of what ran)",
    );
  });

  test("a weaker fallback fails: asked for master, an apprentice answered a journeyman's work", () => {
    expect(
      strictEvaluatorProblem(
        model({ observedModel: "claude-haiku-4-5-20251001" }),
        { smiths: SMITHS, builder: SONNET },
      ),
    ).toBe(
      "observed evaluator claude/claude-haiku-4-5-20251001 (rank apprentice) is below the builder's rank (journeyman)",
    );
  });

  test("a fallback that is still at or above the builder's rank passes", () => {
    expect(
      strictEvaluatorProblem(model({ observedModel: "claude-sonnet-5-5" }), {
        smiths: SMITHS,
        builder: SONNET,
      }),
    ).toBeNull();
  });

  test("the verdict's own rejection stands, whatever the gate would compute", () => {
    expect(
      strictEvaluatorProblem(
        model({
          rankPolicyDecision: "rejected",
          rankPolicyRule: "evaluator-below-builder",
        }),
        { smiths: SMITHS, builder: HAIKU },
      ),
    ).toBe(
      "the verdict records its own rank-policy decision as rejected (evaluator-below-builder)",
    );
  });

  test("the verdict's own 'allowed' does not stand in for the gate's check", () => {
    expect(
      strictEvaluatorProblem(
        model({ observedModel: "claude-haiku-4-5-20251001" }),
        { smiths: SMITHS, builder: OPUS },
      ),
    ).toBe(
      "observed evaluator claude/claude-haiku-4-5-20251001 (rank apprentice) is below the builder's rank (master)",
    );
  });

  test("an observed model that no configured smith ranks fails", () => {
    expect(
      strictEvaluatorProblem(model({ observedModel: "claude-next" }), {
        smiths: SMITHS,
        builder: HAIKU,
      }),
    ).toBe(
      "observed evaluator claude/claude-next has no rank: no configured smith with a rank:* tag uses that provider and model",
    );
  });

  test("when smiths of two ranks share a model, the evaluator is read at the lower and the builder at the higher", () => {
    const shared = [
      ...SMITHS,
      smith("opus-quick", "claude-opus-5-5", ["rank:journeyman"]),
    ];
    // An opus evaluator may have been the journeyman smith: it cannot grade a master's work.
    expect(
      strictEvaluatorProblem(model(), {
        smiths: [
          ...shared,
          smith("gpt-master", "gpt-5-codex", ["rank:master"], "codex"),
        ],
        builder: { provider: "codex", model: "gpt-5-codex" },
      }),
    ).toBe(
      "observed evaluator claude/claude-opus-5-5 (rank journeyman) is below the builder's rank (master)",
    );
    // An opus builder may have been the master smith: a journeyman cannot grade it.
    expect(
      strictEvaluatorProblem(model({ observedModel: "claude-sonnet-5-5" }), {
        smiths: shared,
        builder: OPUS,
      }),
    ).toBe(
      "observed evaluator claude/claude-sonnet-5-5 (rank journeyman) is below the builder's rank (master)",
    );
    // A builder that names its smith is read at that smith's rank.
    expect(
      strictEvaluatorProblem(model({ observedModel: "claude-sonnet-5-5" }), {
        smiths: shared,
        builder: { ...OPUS, smith: "opus-quick" },
      }),
    ).toBeNull();
  });

  test("with no known builder only a master evaluator passes", () => {
    expect(strictEvaluatorProblem(model(), { smiths: SMITHS })).toBeNull();
    expect(
      strictEvaluatorProblem(model({ observedModel: "claude-sonnet-5-5" }), {
        smiths: SMITHS,
      }),
    ).toBe(
      "the run records no builder whose rank is known, so only a master evaluator satisfies grader >= subject; observed evaluator claude/claude-sonnet-5-5 is rank journeyman",
    );
    // A builder on a model nothing ranks is as unknown as no builder.
    expect(
      strictEvaluatorProblem(model({ observedModel: "claude-sonnet-5-5" }), {
        smiths: SMITHS,
        builder: { provider: "claude", model: "claude-next" },
      }),
    ).toStartWith("the run records no builder whose rank is known");
  });
});
