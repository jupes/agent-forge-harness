import { describe, expect, test } from "bun:test";
import { parseEvalVerdictJson, verdictBlocksShip } from "./eval-verdict";

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
        schemaVersion: 2,
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
});
