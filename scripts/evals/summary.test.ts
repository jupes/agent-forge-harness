import { describe, expect, test } from "bun:test";
import { summarizePromptfooResults } from "./summary";

const sample = {
  createdAt: "2026-04-21T10:00:00Z",
  evalConfig: {
    defaultTest: {
      options: { provider: "anthropic:messages:claude-opus-4-6" },
    },
  },
  results: {
    results: [
      {
        description: "PASS",
        success: true,
        cost: 0.012,
        latencyMs: 2100,
        provider: { id: "anthropic:messages:claude-sonnet-4-5", label: "Sonnet 4.5" },
      },
      {
        description: "FAIL",
        success: false,
        cost: 0.018,
        latencyMs: 2500,
        provider: { id: "anthropic:messages:claude-sonnet-4-5", label: "Sonnet 4.5" },
      },
      {
        description: "PASS",
        success: true,
        cost: 0.025,
        latencyMs: 3400,
        provider: { id: "anthropic:messages:claude-haiku-4-5", label: "Haiku 4.5" },
      },
    ],
  },
};

describe("summarizePromptfooResults", () => {
  test("counts per provider + totals", () => {
    const s = summarizePromptfooResults(sample);
    expect(s.totalCases).toBe(3);
    expect(s.passCount).toBe(2);
    expect(s.failCount).toBe(1);
    expect(s.grader).toBe("anthropic:messages:claude-opus-4-6");
    expect(s.providers.length).toBe(2);
    const sonnet = s.providers.find((p) => p.label === "Sonnet 4.5");
    expect(sonnet?.passCount).toBe(1);
    expect(sonnet?.failCount).toBe(1);
    expect(sonnet?.avgCost).toBeCloseTo(0.015, 5);
    expect(sonnet?.avgLatencyMs).toBeCloseTo(2300, 5);
  });

  test("tolerates flat results array", () => {
    const flat = {
      results: [
        {
          success: true,
          provider: "anthropic:messages:claude-sonnet-4-5",
        },
      ],
    };
    const s = summarizePromptfooResults(flat);
    expect(s.totalCases).toBe(1);
    expect(s.providers[0]?.id).toBe("anthropic:messages:claude-sonnet-4-5");
  });

  test("returns zero-shape for empty input", () => {
    const s = summarizePromptfooResults({});
    expect(s.totalCases).toBe(0);
    expect(s.providers).toEqual([]);
  });
});
