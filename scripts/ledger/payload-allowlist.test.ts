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
