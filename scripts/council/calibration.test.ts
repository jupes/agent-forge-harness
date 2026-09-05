import { expect, test } from "bun:test";
import { runCalibration, scoreFindings } from "./calibration";

test("calibration defaults to a no-call plan across all artifact types and depths", async () => {
  const plan = await runCalibration([]);
  expect(plan.mode).toBe("dry-run");
  expect(plan.fixtures).toEqual(["pr", "plan", "research"]);
  expect(plan.comparisons).toEqual(["single", "quick", "balanced", "deep"]);
  expect(plan.estimatedCostUsd).toBe(0);
});

test("calibration distinguishes proxy recall from human usefulness and false positives", () => {
  const score = scoreFindings("pr", [
    {
      title: "Cross-tenant access",
      claim: "The tenant predicate is missing",
      severity: "high",
    },
    { title: "Missing test", claim: "Add an isolation test", severity: "low" },
    { title: "Invented bug", claim: "Unrelated claim", severity: "low" },
  ]);
  expect(score.keywordRecall).toBe(1);
  expect(score.keywordSeverityAgreement).toBe(0.5);
  expect(score.unmatchedFindings).toBe(1);
  expect(score.humanFalsePositives).toBeNull();
  expect(score.humanUsefulness1to5).toBeNull();
});
