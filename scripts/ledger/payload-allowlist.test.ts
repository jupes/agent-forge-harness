import { describe, expect, test } from "bun:test";
import { stripPayload } from "./payload-allowlist";

describe("stripPayload: the usage on session.ended", () => {
  test("keeps the counts and the cost it names, as numbers; drops any other key, and any value that is not a number, under usage", () => {
    expect(
      stripPayload("session.ended", {
        reason: "completed",
        durationMs: 5,
        usage: {
          inputTokens: 1,
          outputTokens: 2,
          costUsd: 0.5,
          cachedInputTokens: "7",
          prompt: "text that must not be stored",
          nested: { inputTokens: 3 },
        },
      }),
    ).toEqual({
      reason: "completed",
      durationMs: 5,
      usage: { inputTokens: 1, outputTokens: 2, costUsd: 0.5 },
    });
  });

  test("a usage with nothing it names is not stored at all", () => {
    for (const usage of [
      { prompt: "text that must not be stored" },
      {},
      "lots",
    ]) {
      expect(
        stripPayload("session.ended", { reason: "completed", usage }),
      ).toEqual({ reason: "completed" });
    }
  });
});

describe("stripPayload: the shift events", () => {
  test("shift.started keeps the bounds a shift ran under: its bead count and its spend", () => {
    expect(
      stripPayload("shift.started", {
        shiftId: "shift-20261014-120000-abcd",
        concurrency: 2,
        durationMs: 60_000,
        filter: "epic:x1gs",
        maxBeads: 4,
        maxUsd: 10,
        prompt: "text that must not be stored",
      }),
    ).toEqual({
      shiftId: "shift-20261014-120000-abcd",
      concurrency: 2,
      durationMs: 60_000,
      filter: "epic:x1gs",
      maxBeads: 4,
      maxUsd: 10,
    });
  });
});

describe("stripPayload: the findings on council.run.finished", () => {
  const finished = (findings: unknown) =>
    stripPayload("council.run.finished", {
      councilRunId: "c-1",
      outcome: "fail",
      findings,
    });

  test("keeps a count per severity, whole numbers only, and nothing else under findings", () => {
    expect(
      finished({
        blocker: 1,
        high: 2,
        medium: 0,
        low: 4,
        title: "a finding's text that must not be stored",
        nested: { blocker: 9 },
      }),
    ).toEqual({
      councilRunId: "c-1",
      outcome: "fail",
      findings: { blocker: 1, high: 2, medium: 0, low: 4 },
    });
  });

  test("a value that is not a whole, non-negative number is dropped, not stored as text", () => {
    expect(
      finished({
        blocker: "no blockers, all good",
        high: 1.5,
        medium: -1,
        low: 3,
      }),
    ).toEqual({
      councilRunId: "c-1",
      outcome: "fail",
      findings: { low: 3 },
    });
  });

  test("findings with no count left, or that are not an object, are not stored at all", () => {
    for (const findings of [
      { title: "text only" },
      { blocker: "many", high: null },
      {},
      "blocker 1",
      7,
      null,
      ["blocker"],
    ])
      expect(finished(findings)).toEqual({
        councilRunId: "c-1",
        outcome: "fail",
      });
  });

  test("a review round's findings are cut the same way", () => {
    expect(
      stripPayload("review.recorded", {
        phase: "plan",
        round: 1,
        verdict: "FAIL",
        findings: { blocker: 1, high: "two", medium: 0, low: 0, note: "text" },
      }),
    ).toEqual({
      phase: "plan",
      round: 1,
      verdict: "FAIL",
      findings: { blocker: 1, medium: 0, low: 0 },
    });
  });
});
